import {
  toolCallCompleted,
  toolCallFailed,
  toolCallStarted,
} from '../events.js';
import {
  ambientContext,
  buildLMCompleted,
  buildLMFailed,
  buildLMStarted,
  contentCaptureEnabled,
  debugLog,
  elapsedMs,
  errorMessage,
  integer,
  importOptionalModule,
  jsonString,
  libraryCaptureEnabled,
  masterCaptureEnabled,
  newCaptureSpan,
  prefixedModel,
  safeEmit,
  stringValue,
  type CaptureSpan,
} from './_common.js';

const SOURCE = 'vercel_ai';

interface CaptureState extends CaptureSpan {
  name: string;
  provider: string;
}

interface TelemetryIntegration {
  onLanguageModelCallStart(event: any): Promise<void>;
  onLanguageModelCallEnd(event: any): Promise<void>;
  onToolExecutionStart(event: any): Promise<void>;
  onToolExecutionEnd(event: any): Promise<void>;
  executeLanguageModelCall<T>(options: { callId: string; execute: () => PromiseLike<T> }): PromiseLike<T>;
}

let enabled = false;
let registered = false;
let otelAttached = false;
const modelSpans = new Map<string, CaptureState>();
const toolSpans = new Map<string, CaptureState>();

/**
 * Enable Vercel AI SDK capture.
 *
 * AI SDK 7+ uses its public global telemetry registry. Earlier releases are
 * supported by best-effort attachment of JournalSpanProcessor to an existing
 * OpenTelemetry provider that exposes addSpanProcessor().
 */
export async function enableVercelAICapture(): Promise<boolean> {
  if (enabled && (registered || otelAttached)) return true;
  if (!captureAllowed()) return false;
  enabled = true;
  try {
    const ai = await importOptionalModule('ai');
    if (!registered && typeof ai.registerTelemetry === 'function') {
      ai.registerTelemetry(journalTelemetry);
      registered = true;
    }
    await attachOpenTelemetryProcessor();
    return registered || otelAttached;
  } catch (error) {
    enabled = false;
    debugLog('Vercel AI SDK not installed; capture disabled', error);
    return false;
  }
}

export function disableVercelAICapture(): void {
  enabled = false;
  modelSpans.clear();
  toolSpans.clear();
}

/**
 * Return an AI SDK namespace whose generation helpers always enable telemetry.
 * This is the explicit path for apps that do not configure
 * `experimental_telemetry` themselves. The original frozen ESM namespace is
 * never mutated.
 */
export function wrapAISDK<T extends Record<string, any>>(ai: T): T {
  enabled = captureAllowed();
  const wrapped = { ...ai } as Record<string, any>;
  for (const name of ['generateText', 'streamText', 'generateObject', 'streamObject']) {
    const original = ai[name];
    if (typeof original !== 'function') continue;
    wrapped[name] = (options: Record<string, any>) => original.call(ai, withTelemetry(options));
  }
  return wrapped as T;
}

function captureAllowed(): boolean {
  return masterCaptureEnabled() && libraryCaptureEnabled('AGNT5_CAPTURE_VERCEL_AI');
}

function withTelemetry(options: Record<string, any> = {}): Record<string, any> {
  const existing = options.experimental_telemetry ?? options.telemetry ?? {};
  const integrations = existing.integrations == null
    ? [journalTelemetry]
    : [...asArray(existing.integrations), journalTelemetry];
  return {
    ...options,
    experimental_telemetry: {
      ...existing,
      isEnabled: existing.isEnabled ?? true,
      integrations,
    },
  };
}

export const journalTelemetry: TelemetryIntegration = {
  async onLanguageModelCallStart(event: any): Promise<void> {
    if (!enabled || modelSpans.has(String(event.callId))) return;
    const ctx = ambientContext();
    if (!ctx) return;
    const provider = normalizeProvider(event.provider);
    const state = {
      ...newCaptureSpan(ctx),
      name: prefixedModel(provider, event.modelId),
      provider,
    };
    modelSpans.set(String(event.callId), state);
    await safeEmit(ctx, buildLMStarted({
      source: SOURCE,
      provider,
      model: state.name,
      correlationId: state.correlationId,
      parentCorrelationId: state.parentCorrelationId,
      messages: contentCaptureEnabled() ? asArray(event.messages) : [],
      systemPrompt: contentCaptureEnabled() ? instructionText(event.instructions ?? event.system) : undefined,
      toolsCount: asArray(event.tools).length,
      temperature: numberValue(event.temperature),
      maxTokens: numberValue(event.maxOutputTokens),
    }));
  },

  async onLanguageModelCallEnd(event: any): Promise<void> {
    const state = modelSpans.get(String(event.callId));
    modelSpans.delete(String(event.callId));
    if (!enabled || !state) return;
    const usage = event.usage;
    const inputTokens = integer(usage?.inputTokens);
    const outputTokens = integer(usage?.outputTokens);
    await safeEmit(state.ctx, buildLMCompleted({
      source: SOURCE,
      provider: state.provider,
      model: event.modelId ? prefixedModel(state.provider, event.modelId) : state.name,
      correlationId: state.correlationId,
      parentCorrelationId: state.parentCorrelationId,
      durationMs: elapsedMs(state),
      inputTokens,
      outputTokens,
      totalTokens: integer(usage?.totalTokens) || inputTokens + outputTokens,
      cachedTokens: integer(usage?.inputTokenDetails?.cacheReadTokens),
      finishReason: stringValue(event.finishReason),
      output: contentCaptureEnabled() ? contentText(event.content) : '',
      toolCalls: contentCaptureEnabled() ? contentToolCalls(event.content) : undefined,
    }));
  },

  async onToolExecutionStart(event: any): Promise<void> {
    if (!enabled) return;
    const ctx = ambientContext();
    if (!ctx) return;
    const toolCall = event.toolCall ?? {};
    const callId = String(toolCall.toolCallId ?? toolCall.id ?? event.callId);
    const key = `${event.callId}:${callId}`;
    if (toolSpans.has(key)) return;
    const state = { ...newCaptureSpan(ctx), name: String(toolCall.toolName ?? 'tool'), provider: '' };
    toolSpans.set(key, state);
    await safeEmit(ctx, toolCallStarted(state.correlationId, state.parentCorrelationId, {
      toolName: state.name,
      toolCallId: callId,
      inputData: contentCaptureEnabled() ? toolCall.input : undefined,
      source: SOURCE,
    }));
  },

  async onToolExecutionEnd(event: any): Promise<void> {
    const toolCall = event.toolCall ?? {};
    const callId = String(toolCall.toolCallId ?? toolCall.id ?? event.callId);
    const key = `${event.callId}:${callId}`;
    const state = toolSpans.get(key);
    toolSpans.delete(key);
    if (!enabled || !state) return;
    const output = event.toolOutput ?? {};
    const durationMs = integer(event.toolExecutionMs) || elapsedMs(state);
    if (output.type === 'tool-error') {
      await safeEmit(state.ctx, toolCallFailed(state.correlationId, state.parentCorrelationId, {
        toolName: state.name,
        toolCallId: callId,
        error: errorMessage(output.error),
        durationMs,
        source: SOURCE,
      }));
    } else {
      await safeEmit(state.ctx, toolCallCompleted(state.correlationId, state.parentCorrelationId, {
        toolName: state.name,
        toolCallId: callId,
        outputData: contentCaptureEnabled() ? { result: output.output ?? output } : undefined,
        durationMs,
        source: SOURCE,
      }));
    }
  },

  async executeLanguageModelCall<T>(options: { callId: string; execute: () => PromiseLike<T> }): Promise<T> {
    try {
      return await options.execute();
    } catch (error) {
      const state = modelSpans.get(String(options.callId));
      modelSpans.delete(String(options.callId));
      if (enabled && state) {
        await safeEmit(state.ctx, buildLMFailed({
          source: SOURCE,
          provider: state.provider,
          model: state.name,
          correlationId: state.correlationId,
          parentCorrelationId: state.parentCorrelationId,
          durationMs: elapsedMs(state),
          error,
        }));
      }
      throw error;
    }
  },
};

/** OpenTelemetry SpanProcessor used by AI SDK versions without integrations. */
export class JournalSpanProcessor {
  private readonly spans = new WeakMap<object, CaptureState>();

  onStart(span: any, _parentContext?: unknown): void {
    if (!enabled || !isLegacyAISpan(span)) return;
    const ctx = ambientContext();
    if (!ctx) return;
    const attributes = span.attributes ?? {};
    const provider = normalizeProvider(attribute(attributes, 'ai.model.provider', 'gen_ai.system'));
    const model = prefixedModel(provider, attribute(attributes, 'ai.model.id', 'gen_ai.request.model'));
    const state = { ...newCaptureSpan(ctx), name: model, provider };
    this.spans.set(span, state);
    void safeEmit(ctx, buildLMStarted({
      source: SOURCE,
      provider,
      model,
      correlationId: state.correlationId,
      parentCorrelationId: state.parentCorrelationId,
      messages: contentCaptureEnabled() ? parseJSONAttribute(attribute(attributes, 'ai.prompt.messages', 'gen_ai.prompt')) : [],
      toolsCount: integer(attribute(attributes, 'ai.prompt.tools.count')),
      temperature: numberValue(attribute(attributes, 'ai.settings.temperature', 'gen_ai.request.temperature')),
      maxTokens: numberValue(attribute(attributes, 'ai.settings.maxOutputTokens', 'gen_ai.request.max_tokens')),
    }));
  }

  onEnd(span: any): void {
    const state = this.spans.get(span);
    this.spans.delete(span);
    if (!enabled || !state) return;
    const attributes = span.attributes ?? {};
    if (span.status?.code === 2) {
      void safeEmit(state.ctx, buildLMFailed({
        source: SOURCE,
        provider: state.provider,
        model: state.name,
        correlationId: state.correlationId,
        parentCorrelationId: state.parentCorrelationId,
        durationMs: elapsedMs(state),
        error: new Error(String(span.status?.message ?? 'AI SDK model call failed')),
      }));
      return;
    }
    const inputTokens = integer(attribute(attributes, 'ai.usage.promptTokens', 'gen_ai.usage.input_tokens'));
    const outputTokens = integer(attribute(attributes, 'ai.usage.completionTokens', 'gen_ai.usage.output_tokens'));
    void safeEmit(state.ctx, buildLMCompleted({
      source: SOURCE,
      provider: state.provider,
      model: state.name,
      correlationId: state.correlationId,
      parentCorrelationId: state.parentCorrelationId,
      durationMs: elapsedMs(state),
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cachedTokens: integer(attribute(attributes, 'ai.usage.cachedTokens', 'gen_ai.usage.cached_input_tokens')),
      finishReason: stringValue(attribute(attributes, 'ai.response.finishReason', 'gen_ai.response.finish_reasons')),
      output: contentCaptureEnabled() ? String(attribute(attributes, 'ai.response.text', 'gen_ai.completion') ?? '') : '',
    }));
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}

async function attachOpenTelemetryProcessor(): Promise<void> {
  if (otelAttached) return;
  try {
    const otel = await importOptionalModule('@opentelemetry/api');
    const proxy = otel.trace?.getTracerProvider?.();
    const provider = typeof proxy?.getDelegate === 'function' ? proxy.getDelegate() : proxy;
    if (typeof provider?.addSpanProcessor === 'function') {
      provider.addSpanProcessor(new JournalSpanProcessor());
      otelAttached = true;
    }
  } catch (error) {
    debugLog('OpenTelemetry provider unavailable for Vercel AI capture', error);
  }
}

function isLegacyAISpan(span: any): boolean {
  const name = String(span?.name ?? '');
  return name.startsWith('ai.') && (/doGenerate|doStream|languageModel/i.test(name));
}

function attribute(attributes: Record<string, any>, ...keys: string[]): any {
  for (const key of keys) if (attributes[key] !== undefined) return attributes[key];
  return undefined;
}

function parseJSONAttribute(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [{ role: 'user', content: value }];
  }
}

function normalizeProvider(provider: unknown): string {
  const value = String(provider ?? 'unknown');
  return value.split(/[.:/]/, 1)[0] || 'unknown';
}

function instructionText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  return value == null ? undefined : jsonString(value);
}

function contentText(content: unknown): string {
  return asArray(content)
    .filter((part) => part?.type === 'text' || typeof part?.text === 'string')
    .map((part) => String(part.text ?? ''))
    .join('');
}

function contentToolCalls(content: unknown): any[] | undefined {
  const calls = asArray(content).filter((part) => String(part?.type ?? '').includes('tool-call'));
  return calls.length ? calls : undefined;
}

function asArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function numberValue(value: unknown, fallback?: unknown): number | undefined {
  const selected = value ?? fallback;
  if (selected == null) return undefined;
  const parsed = Number(selected);
  return Number.isFinite(parsed) ? parsed : undefined;
}
