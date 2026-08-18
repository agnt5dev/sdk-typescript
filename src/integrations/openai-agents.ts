import {
  agentCompleted,
  agentFailed,
  agentStarted,
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
  jsonString,
  libraryCaptureEnabled,
  masterCaptureEnabled,
  newCaptureSpan,
  prefixedModel,
  safeEmit,
  stringValue,
  type CaptureSpan,
} from './_common.js';

const SOURCE = 'openai_agents';
const PROVIDER = 'openai';

type SpanKind = 'agent' | 'lm' | 'tool' | 'passthrough';

interface SpanState extends CaptureSpan {
  kind: SpanKind;
  name: string;
}

interface AgentsModule {
  addTraceProcessor?: (processor: CaptureProcessor) => void;
  setTracingDisabled?: (disabled: boolean) => void;
  getCurrentSpan?: () => any;
}

let enabled = false;
let currentSpan: (() => any) | undefined;
let processor: CaptureProcessor | undefined;

/** Attach the public Agents SDK trace processor and force tracing on. */
export async function enableOpenAIAgentsCapture(): Promise<boolean> {
  if (enabled) return true;
  if (!masterCaptureEnabled() || !libraryCaptureEnabled('AGNT5_CAPTURE_OPENAI_AGENTS')) {
    return false;
  }
  try {
    const agents = await import('@openai/agents') as AgentsModule;
    if (typeof agents.addTraceProcessor !== 'function') return false;
    processor ??= new CaptureProcessor();
    agents.setTracingDisabled?.(false);
    agents.addTraceProcessor(processor);
    currentSpan = agents.getCurrentSpan;
    enabled = true;
    return true;
  } catch (error) {
    debugLog('@openai/agents not installed; capture disabled', error);
    return false;
  }
}

/** The Agents SDK does not expose processor removal; the processor goes inert. */
export function disableOpenAIAgentsCapture(): void {
  enabled = false;
  currentSpan = undefined;
}

/** Avoid journaling the raw OpenAI call already represented by an Agents span. */
export function suppressesClientCapture(): boolean {
  if (!enabled || !currentSpan) return false;
  try {
    const type = currentSpan()?.spanData?.type;
    return type === 'generation' || type === 'response';
  } catch {
    return false;
  }
}

export class CaptureProcessor {
  private readonly spans = new Map<string, SpanState>();

  async onTraceStart(_trace: any): Promise<void> {}

  async onTraceEnd(trace: any): Promise<void> {
    const prefix = `${trace?.traceId ?? ''}:`;
    for (const key of this.spans.keys()) {
      if (key.startsWith(prefix)) this.spans.delete(key);
    }
  }

  async onSpanStart(span: any): Promise<void> {
    if (!enabled) return;
    const ctx = ambientContext();
    if (!ctx) return;
    const key = spanKey(span);
    const parentState = span?.parentId ? this.spans.get(`${span.traceId}:${span.parentId}`) : undefined;
    const capture = newCaptureSpan(ctx);
    if (parentState) capture.parentCorrelationId = parentState.correlationId;
    const data = span?.spanData ?? {};
    const type = String(data.type ?? '');

    if (type === 'agent') {
      const name = String(data.name ?? 'agent');
      this.spans.set(key, { ...capture, kind: 'agent', name });
      await safeEmit(ctx, agentStarted(name, capture.correlationId, {
        agentModel: '',
        toolNames: stringArray(data.tools),
        maxIterations: 0,
        parentCorrelationId: capture.parentCorrelationId,
        source: SOURCE,
      }));
      return;
    }

    if (type === 'generation' || type === 'response') {
      const name = prefixedModel(PROVIDER, data.model);
      this.spans.set(key, { ...capture, kind: 'lm', name });
      const input = lmInput(data);
      await safeEmit(ctx, buildLMStarted({
        source: SOURCE,
        provider: PROVIDER,
        model: name,
        correlationId: capture.correlationId,
        parentCorrelationId: capture.parentCorrelationId,
        messages: contentCaptureEnabled() ? input.messages : [],
        systemPrompt: contentCaptureEnabled() ? input.systemPrompt : undefined,
        toolsCount: input.toolsCount,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
      }));
      return;
    }

    if (type === 'function') {
      const name = String(data.name ?? 'tool');
      this.spans.set(key, { ...capture, kind: 'tool', name });
      await safeEmit(ctx, toolCallStarted(capture.correlationId, capture.parentCorrelationId, {
        toolName: name,
        toolCallId: capture.correlationId,
        inputData: contentCaptureEnabled() ? { input: data.input } : undefined,
        source: SOURCE,
      }));
      return;
    }

    // Unsupported spans remain transparent for correlation nesting.
    this.spans.set(key, {
      ...capture,
      correlationId: capture.parentCorrelationId,
      kind: 'passthrough',
      name: '',
    });
  }

  async onSpanEnd(span: any): Promise<void> {
    const state = this.spans.get(spanKey(span));
    this.spans.delete(spanKey(span));
    if (!enabled || !state || state.kind === 'passthrough') return;
    const data = span?.spanData ?? {};
    const durationMs = elapsedMs(state);
    const error = span?.error;

    if (state.kind === 'agent') {
      if (error) {
        await safeEmit(state.ctx, agentFailed(state.name, state.correlationId, {
          iterations: 0,
          error: errorMessage(error),
          parentCorrelationId: state.parentCorrelationId,
          durationMs,
          source: SOURCE,
        }));
      } else {
        await safeEmit(state.ctx, agentCompleted(state.name, state.correlationId, {
          iterations: 0,
          toolCallsCount: 0,
          handoffTo: null,
          outputLength: 0,
          output: '',
          toolCalls: [],
          parentCorrelationId: state.parentCorrelationId,
          durationMs,
          source: SOURCE,
        }));
      }
      return;
    }

    if (state.kind === 'lm') {
      if (error) {
        await safeEmit(state.ctx, buildLMFailed({
          source: SOURCE,
          provider: PROVIDER,
          model: state.name,
          correlationId: state.correlationId,
          parentCorrelationId: state.parentCorrelationId,
          durationMs,
          error: new Error(errorMessage(error)),
        }));
      } else {
        await safeEmit(state.ctx, buildLMCompleted({
          ...lmCompletedFields(data, state.name),
          source: SOURCE,
          provider: PROVIDER,
          correlationId: state.correlationId,
          parentCorrelationId: state.parentCorrelationId,
          durationMs,
        }));
      }
      return;
    }

    if (error) {
      await safeEmit(state.ctx, toolCallFailed(state.correlationId, state.parentCorrelationId, {
        toolName: state.name,
        toolCallId: state.correlationId,
        error: errorMessage(error),
        durationMs,
        source: SOURCE,
      }));
    } else {
      await safeEmit(state.ctx, toolCallCompleted(state.correlationId, state.parentCorrelationId, {
        toolName: state.name,
        toolCallId: state.correlationId,
        outputData: contentCaptureEnabled() ? { result: data.output } : undefined,
        durationMs,
        source: SOURCE,
      }));
    }
  }

  async shutdown(_timeout?: number): Promise<void> {}

  async forceFlush(): Promise<void> {}
}

function spanKey(span: any): string {
  return `${span?.traceId ?? ''}:${span?.spanId ?? ''}`;
}

function lmInput(data: any): {
  messages: unknown[];
  systemPrompt?: string;
  toolsCount: number;
  temperature?: number;
  maxTokens?: number;
} {
  const config = data?.model_config ?? data?.modelConfig ?? {};
  const input = data?.input ?? data?._input;
  return {
    messages: Array.isArray(input) ? input : input == null ? [] : [{ role: 'user', content: input }],
    systemPrompt: stringValue(config.system_prompt ?? config.systemPrompt),
    toolsCount: Array.isArray(config.tools) ? config.tools.length : 0,
    temperature: numberValue(config.temperature),
    maxTokens: numberValue(config.max_tokens ?? config.maxTokens),
  };
}

function lmCompletedFields(data: any, requestModel: string) {
  const response = data?._response ?? data?.response;
  if (response) {
    const usage = response.usage;
    const inputTokens = integer(usage?.input_tokens);
    const outputTokens = integer(usage?.output_tokens);
    return {
      model: response.model ? prefixedModel(PROVIDER, response.model) : requestModel,
      inputTokens,
      outputTokens,
      totalTokens: integer(usage?.total_tokens) || inputTokens + outputTokens,
      cachedTokens: integer(usage?.input_tokens_details?.cached_tokens),
      finishReason: stringValue(response.status),
      output: contentCaptureEnabled() ? String(response.output_text ?? '') : '',
      toolCalls: contentCaptureEnabled() ? responseToolCalls(response.output) : undefined,
    };
  }
  const usage = data?.usage;
  const inputTokens = integer(usage?.input_tokens ?? usage?.prompt_tokens);
  const outputTokens = integer(usage?.output_tokens ?? usage?.completion_tokens);
  return {
    model: data?.model ? prefixedModel(PROVIDER, data.model) : requestModel,
    inputTokens,
    outputTokens,
    totalTokens: integer(usage?.total_tokens) || inputTokens + outputTokens,
    cachedTokens: integer(usage?.cached_tokens ?? usage?.details?.cached_tokens),
    output: contentCaptureEnabled() ? jsonString(data?.output) : '',
  };
}

function responseToolCalls(output: unknown): Record<string, any>[] | undefined {
  if (!Array.isArray(output)) return undefined;
  const calls = output
    .filter((item) => item?.type === 'function_call')
    .map((item) => ({ id: item.call_id ?? item.id, name: item.name, arguments: item.arguments }));
  return calls.length ? calls : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function numberValue(value: unknown): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
