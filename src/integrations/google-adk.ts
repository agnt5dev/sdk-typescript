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

const SOURCE = 'google_adk';
const PROVIDER = 'google';
const PLUGIN_NAME = 'agnt5_capture';

type AnyFunction = (...args: any[]) => any;
type CapturePluginInstance = {
  failOpenSpans?: (ctx: unknown, error: unknown) => Promise<void>;
};
type PluginConstructor = new () => CapturePluginInstance;

interface NamedSpan extends CaptureSpan {
  name: string;
}

interface PatchRecord {
  target: Record<string, any>;
  name: string;
  original: AnyFunction;
}

let enabled = false;
let CapturePlugin: PluginConstructor | undefined;
const patches: PatchRecord[] = [];

/** Attach an AGNT5 plugin before each Runner invocation (ADK 1.x+). */
export async function enableGoogleADKCapture(): Promise<boolean> {
  if (enabled) return true;
  if (!captureAllowed()) return false;
  try {
    const adk = await importOptionalModule('@google/adk');
    const version = String(adk.version ?? '');
    if (!supportedVersion(version)) {
      debugLog(`@google/adk ${version || 'unknown'} is unsupported; capture disabled`);
      return false;
    }
    if (typeof adk.BasePlugin !== 'function' || typeof adk.Runner !== 'function') return false;
    CapturePlugin = createCapturePluginClass(adk.BasePlugin);
    patchRunnerMethod(adk.Runner.prototype, 'runAsync');
    patchRunnerMethod(adk.Runner.prototype, 'runEphemeral');
    enabled = patches.length > 0;
    return enabled;
  } catch (error) {
    debugLog('@google/adk not installed; capture disabled', error);
    return false;
  }
}

export function disableGoogleADKCapture(): void {
  for (const patch of patches.splice(0)) patch.target[patch.name] = patch.original;
  CapturePlugin = undefined;
  enabled = false;
}

/** Exposed for explicit plugin registration and compatibility tests. */
export async function createGoogleADKCapturePlugin(): Promise<any | undefined> {
  if (!captureAllowed()) return undefined;
  try {
    const adk = await importOptionalModule('@google/adk');
    if (!supportedVersion(String(adk.version ?? '')) || typeof adk.BasePlugin !== 'function') {
      return undefined;
    }
    const Plugin = CapturePlugin ?? createCapturePluginClass(adk.BasePlugin);
    enabled = true;
    return new Plugin();
  } catch {
    return undefined;
  }
}

function captureAllowed(): boolean {
  return masterCaptureEnabled() && libraryCaptureEnabled('AGNT5_CAPTURE_GOOGLE_ADK');
}

function patchRunnerMethod(target: Record<string, any>, name: string): void {
  if (typeof target?.[name] !== 'function') return;
  const original = target[name] as AnyFunction;
  patches.push({ target, name, original });
  target[name] = function captureADKRun(this: any, ...args: any[]) {
    let plugin: CapturePluginInstance | undefined;
    try {
      const manager = this.pluginManager;
      plugin = manager?.getPlugin?.(PLUGIN_NAME);
      if (manager && !plugin && CapturePlugin) {
        plugin = new CapturePlugin();
        manager.registerPlugin(plugin);
      }
    } catch (error) {
      debugLog('Google ADK capture plugin registration failed', error);
    }
    const ctx = ambientContext();
    try {
      const result = original.apply(this, args);
      return ctx && isAsyncIterable(result) ? captureRunnerErrors(result, plugin, ctx) : result;
    } catch (error) {
      if (ctx) void plugin?.failOpenSpans?.(ctx, error);
      throw error;
    }
  };
}

function captureRunnerErrors(
  inner: AsyncIterable<any>,
  plugin: CapturePluginInstance | undefined,
  ctx: unknown,
): AsyncIterable<any> {
  return new Proxy(inner as object, {
    get(target, property, receiver) {
      if (property === Symbol.asyncIterator) {
        return () => {
          const iterator = (target as AsyncIterable<any>)[Symbol.asyncIterator]();
          return {
            async next(...args: []): Promise<IteratorResult<any>> {
              try {
                return await iterator.next(...args);
              } catch (error) {
                await plugin?.failOpenSpans?.(ctx, error);
                throw error;
              }
            },
            async return(value?: any): Promise<IteratorResult<any>> {
              const result = iterator.return
                ? await iterator.return(value)
                : { done: true as const, value };
              await plugin?.failOpenSpans?.(ctx, new Error('Google ADK run ended before completion'));
              return result;
            },
            async throw(error?: any): Promise<IteratorResult<any>> {
              await plugin?.failOpenSpans?.(ctx, error);
              if (iterator.throw) return iterator.throw(error);
              throw error;
            },
          };
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as AsyncIterable<any>;
}

export function supportedVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  return major >= 1;
}

function createCapturePluginClass(BasePlugin: new (name: string) => any): PluginConstructor {
  return class Agnt5CapturePlugin extends BasePlugin {
    private readonly agentSpans = new Map<string, NamedSpan>();
    private readonly agentStacks = new Map<string, string[]>();
    private readonly modelSpans = new Map<string, NamedSpan>();
    private readonly toolSpans = new Map<string, NamedSpan>();

    constructor() {
      super(PLUGIN_NAME);
    }

    // ADK JS 1.6 exposes agent plugin callbacks but does not dispatch them.
    // Run callbacks provide the public root-agent lifecycle; the agent
    // callbacks below remain for later releases that dispatch them.
    async beforeRunCallback({ invocationContext }: any): Promise<void> {
      await this.beginAgent(invocationContext?.agent, invocationContext);
    }

    async afterRunCallback({ invocationContext }: any): Promise<void> {
      await this.completeAgent(invocationContext?.agent, invocationContext);
      this.purge(String(invocationContext?.invocationId ?? ''));
    }

    async beforeAgentCallback({ agent, callbackContext }: any): Promise<void> {
      await this.beginAgent(agent, callbackContext);
    }

    async afterAgentCallback({ agent, callbackContext }: any): Promise<void> {
      await this.completeAgent(agent, callbackContext);
    }

    private async beginAgent(agent: any, callbackContext: any): Promise<void> {
      if (!enabled) return;
      const ctx = ambientContext();
      if (!ctx) return;
      const key = agentKey(callbackContext, agent);
      if (this.agentSpans.has(key)) return;
      const invocationId = invocation(callbackContext);
      const stack = this.agentStacks.get(invocationId) ?? [];
      const span = newCaptureSpan(ctx);
      if (stack.length) span.parentCorrelationId = stack[stack.length - 1];
      const name = agentName(callbackContext, agent);
      this.agentSpans.set(key, { ...span, name });
      stack.push(span.correlationId);
      this.agentStacks.set(invocationId, stack);
      await safeEmit(ctx, agentStarted(name, span.correlationId, {
        agentModel: String(agent?.model ?? ''),
        toolNames: [],
        maxIterations: 0,
        parentCorrelationId: span.parentCorrelationId,
        source: SOURCE,
      }));
    }

    private async completeAgent(agent: any, callbackContext: any): Promise<void> {
      const key = agentKey(callbackContext, agent);
      const span = this.agentSpans.get(key);
      this.agentSpans.delete(key);
      if (!enabled || !span) return;
      this.popAgent(invocation(callbackContext), span.correlationId);
      await safeEmit(span.ctx, agentCompleted(span.name, span.correlationId, {
        iterations: 0,
        toolCallsCount: 0,
        handoffTo: null,
        outputLength: 0,
        output: '',
        toolCalls: [],
        parentCorrelationId: span.parentCorrelationId,
        durationMs: elapsedMs(span),
        source: SOURCE,
      }));
    }

    async onAgentErrorCallback({ agent, callbackContext, error }: any): Promise<void> {
      const key = agentKey(callbackContext, agent);
      const existing = this.agentSpans.get(key);
      this.agentSpans.delete(key);
      if (!enabled) return;
      const ctx = existing?.ctx ?? ambientContext();
      if (!ctx) return;
      const span = existing ?? { ...newCaptureSpan(ctx), name: agentName(callbackContext, agent) };
      this.popAgent(invocation(callbackContext), span.correlationId);
      await safeEmit(ctx, agentFailed(span.name, span.correlationId, {
        iterations: 0,
        error: errorMessage(error),
        parentCorrelationId: span.parentCorrelationId,
        durationMs: elapsedMs(span),
        source: SOURCE,
      }));
    }

    async beforeModelCallback({ callbackContext, llmRequest }: any): Promise<void> {
      if (!enabled) return;
      const ctx = ambientContext();
      if (!ctx) return;
      const span = newCaptureSpan(ctx);
      span.parentCorrelationId = this.parentFor(invocation(callbackContext), span.parentCorrelationId);
      const name = prefixedModel(PROVIDER, llmRequest?.model);
      this.modelSpans.set(modelKey(callbackContext), { ...span, name });
      await safeEmit(ctx, buildLMStarted({
        source: SOURCE,
        provider: PROVIDER,
        model: name,
        correlationId: span.correlationId,
        parentCorrelationId: span.parentCorrelationId,
        messages: contentCaptureEnabled() ? serializeContents(llmRequest?.contents) : [],
        systemPrompt: contentCaptureEnabled() ? systemInstruction(llmRequest?.config?.systemInstruction) : undefined,
        toolsCount: Object.keys(llmRequest?.toolsDict ?? {}).length,
        temperature: numberValue(llmRequest?.config?.temperature),
        maxTokens: numberValue(llmRequest?.config?.maxOutputTokens),
      }));
    }

    async afterModelCallback({ callbackContext, llmResponse }: any): Promise<void> {
      if (llmResponse?.partial) return;
      const key = modelKey(callbackContext);
      const span = this.modelSpans.get(key);
      this.modelSpans.delete(key);
      if (!enabled || !span) return;
      const usage = llmResponse?.usageMetadata;
      const inputTokens = integer(usage?.promptTokenCount);
      const outputTokens = integer(usage?.candidatesTokenCount);
      await safeEmit(span.ctx, buildLMCompleted({
        source: SOURCE,
        provider: PROVIDER,
        model: llmResponse?.modelVersion ? prefixedModel(PROVIDER, llmResponse.modelVersion) : span.name,
        correlationId: span.correlationId,
        parentCorrelationId: span.parentCorrelationId,
        durationMs: elapsedMs(span),
        inputTokens,
        outputTokens,
        totalTokens: integer(usage?.totalTokenCount) || inputTokens + outputTokens,
        cachedTokens: integer(usage?.cachedContentTokenCount),
        finishReason: stringValue(llmResponse?.finishReason),
        output: contentCaptureEnabled() ? responseText(llmResponse) : '',
        toolCalls: contentCaptureEnabled() ? responseToolCalls(llmResponse) : undefined,
      }));
    }

    async onModelErrorCallback({ callbackContext, llmRequest, error }: any): Promise<void> {
      const key = modelKey(callbackContext);
      const existing = this.modelSpans.get(key);
      this.modelSpans.delete(key);
      if (!enabled) return;
      const ctx = existing?.ctx ?? ambientContext();
      if (!ctx) return;
      const span = existing ?? { ...newCaptureSpan(ctx), name: prefixedModel(PROVIDER, llmRequest?.model) };
      await safeEmit(ctx, buildLMFailed({
        source: SOURCE,
        provider: PROVIDER,
        model: span.name,
        correlationId: span.correlationId,
        parentCorrelationId: span.parentCorrelationId,
        durationMs: elapsedMs(span),
        error,
      }));
    }

    async beforeToolCallback({ tool, toolArgs, toolContext }: any): Promise<void> {
      if (!enabled) return;
      const ctx = ambientContext();
      if (!ctx) return;
      const span = newCaptureSpan(ctx);
      span.parentCorrelationId = this.parentFor(invocation(toolContext), span.parentCorrelationId);
      const name = String(tool?.name ?? 'tool');
      const callId = String(toolContext?.functionCallId ?? span.correlationId);
      this.toolSpans.set(toolKey(toolContext, callId), { ...span, name });
      await safeEmit(ctx, toolCallStarted(span.correlationId, span.parentCorrelationId, {
        toolName: name,
        toolCallId: callId,
        inputData: contentCaptureEnabled() ? toolArgs : undefined,
        source: SOURCE,
      }));
    }

    async afterToolCallback({ tool, toolContext, result }: any): Promise<void> {
      const callId = String(toolContext?.functionCallId ?? '');
      const key = toolKey(toolContext, callId);
      const span = this.toolSpans.get(key);
      this.toolSpans.delete(key);
      if (!enabled || !span) return;
      await safeEmit(span.ctx, toolCallCompleted(span.correlationId, span.parentCorrelationId, {
        toolName: span.name || String(tool?.name ?? 'tool'),
        toolCallId: callId,
        outputData: contentCaptureEnabled() ? { result } : undefined,
        durationMs: elapsedMs(span),
        source: SOURCE,
      }));
    }

    async onToolErrorCallback({ tool, toolContext, error }: any): Promise<void> {
      const callId = String(toolContext?.functionCallId ?? '');
      const key = toolKey(toolContext, callId);
      const existing = this.toolSpans.get(key);
      this.toolSpans.delete(key);
      if (!enabled) return;
      const ctx = existing?.ctx ?? ambientContext();
      if (!ctx) return;
      const span = existing ?? { ...newCaptureSpan(ctx), name: String(tool?.name ?? 'tool') };
      await safeEmit(ctx, toolCallFailed(span.correlationId, span.parentCorrelationId, {
        toolName: span.name,
        toolCallId: callId || span.correlationId,
        error: errorMessage(error),
        durationMs: elapsedMs(span),
        source: SOURCE,
      }));
    }

    async onRunErrorCallback({ invocationContext }: any): Promise<void> {
      this.purge(String(invocationContext?.invocationId ?? ''));
    }

    async failOpenSpans(ctx: unknown, error: unknown): Promise<void> {
      const matches = (span: NamedSpan) => span.ctx === ctx;
      const failedInvocations = new Set<string>();
      for (const [key, span] of [...this.modelSpans]) {
        if (!matches(span)) continue;
        this.modelSpans.delete(key);
        await safeEmit(span.ctx, buildLMFailed({
          source: SOURCE,
          provider: PROVIDER,
          model: span.name,
          correlationId: span.correlationId,
          parentCorrelationId: span.parentCorrelationId,
          durationMs: elapsedMs(span),
          error,
        }));
      }
      for (const [key, span] of [...this.toolSpans]) {
        if (!matches(span)) continue;
        this.toolSpans.delete(key);
        await safeEmit(span.ctx, toolCallFailed(span.correlationId, span.parentCorrelationId, {
          toolName: span.name,
          toolCallId: key.slice(key.indexOf(':') + 1),
          error: errorMessage(error),
          durationMs: elapsedMs(span),
          source: SOURCE,
        }));
      }
      for (const [key, span] of [...this.agentSpans]) {
        if (!matches(span)) continue;
        this.agentSpans.delete(key);
        failedInvocations.add(key.slice(0, key.indexOf(':')));
        await safeEmit(span.ctx, agentFailed(span.name, span.correlationId, {
          iterations: 0,
          error: errorMessage(error),
          parentCorrelationId: span.parentCorrelationId,
          durationMs: elapsedMs(span),
          source: SOURCE,
        }));
      }
      for (const invocationId of failedInvocations) this.agentStacks.delete(invocationId);
    }

    private parentFor(invocationId: string, fallback: string): string {
      const stack = this.agentStacks.get(invocationId) ?? [];
      return stack[stack.length - 1] ?? fallback;
    }

    private popAgent(invocationId: string, correlationId: string): void {
      const stack = this.agentStacks.get(invocationId);
      if (!stack) return;
      const index = stack.lastIndexOf(correlationId);
      if (index >= 0) stack.splice(index, 1);
      if (!stack.length) this.agentStacks.delete(invocationId);
    }

    private purge(invocationId: string): void {
      if (!invocationId) return;
      this.agentStacks.delete(invocationId);
      for (const spans of [this.agentSpans, this.modelSpans, this.toolSpans]) {
        for (const key of spans.keys()) if (key.startsWith(`${invocationId}:`)) spans.delete(key);
      }
    }
  };
}

function invocation(context: any): string {
  return String(context?.invocationId ?? context?.invocation_id ?? '');
}

function agentName(context: any, agent: any): string {
  return String(context?.agentName ?? context?.agent_name ?? agent?.name ?? 'agent');
}

function agentKey(context: any, agent: any): string {
  return `${invocation(context)}:${agentName(context, agent)}`;
}

function modelKey(context: any): string {
  return `${invocation(context)}:${agentName(context, undefined)}`;
}

function toolKey(context: any, callId: string): string {
  return `${invocation(context)}:${callId}`;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<any> {
  return Boolean(value) && typeof (value as AsyncIterable<any>)[Symbol.asyncIterator] === 'function';
}

function serializeContents(contents: unknown): unknown[] {
  return Array.isArray(contents) ? contents : contents == null ? [] : [contents];
}

function systemInstruction(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  return value == null ? undefined : jsonString(value);
}

function responseText(response: any): string {
  return (response?.content?.parts ?? [])
    .filter((part: any) => typeof part?.text === 'string')
    .map((part: any) => part.text)
    .join('');
}

function responseToolCalls(response: any): Record<string, any>[] | undefined {
  const calls = (response?.content?.parts ?? [])
    .map((part: any) => part?.functionCall)
    .filter(Boolean)
    .map((call: any) => ({ id: call.id, name: call.name, arguments: call.args }));
  return calls.length ? calls : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
