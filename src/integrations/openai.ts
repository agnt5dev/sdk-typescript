import {
  ambientContext,
  buildLMCompleted,
  buildLMFailed,
  buildLMStarted,
  contentCaptureEnabled,
  debugLog,
  elapsedMs,
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
  type LMCompletedFields,
} from './_common.js';
import { suppressesClientCapture } from './openai-agents.js';

const SOURCE = 'openai';
const PROVIDER = 'openai';

type AnyFunction = (...args: any[]) => any;

interface Surface {
  key: string;
  supportsStreaming: boolean;
  started(body: Record<string, any>, model: string, span: CaptureSpan): ReturnType<typeof buildLMStarted>;
  completed(response: any, requestModel: string): Omit<LMCompletedFields, keyof CaptureSpan | 'source' | 'provider' | 'durationMs'>;
  responseError?(response: any): Error | undefined;
  streamState(requestModel: string): StreamState;
  accumulate(state: StreamState, chunk: any): void;
  streamCompleted(state: StreamState): Omit<LMCompletedFields, keyof CaptureSpan | 'source' | 'provider' | 'durationMs'>;
}

interface StreamState {
  requestModel: string;
  model?: string;
  usage?: any;
  parts: string[];
  toolCalls: Map<number, Record<string, any>>;
  finishReason?: string;
  error?: unknown;
}

interface PatchRecord {
  target: Record<string, any>;
  original: AnyFunction;
}

const patches: PatchRecord[] = [];
let enabled = false;

/** Patch OpenAI resource prototypes. Existing client instances are covered. */
export async function enableOpenAICapture(): Promise<boolean> {
  if (enabled) return true;
  if (!masterCaptureEnabled() || !libraryCaptureEnabled('AGNT5_CAPTURE_OPENAI')) return false;
  try {
    await importOptionalModule('openai');
    const [chat, responses, embeddings] = await Promise.all([
      importOptionalModule('openai/resources/chat/completions'),
      importOptionalModule('openai/resources/responses/responses'),
      importOptionalModule('openai/resources/embeddings'),
    ]);
    patchCreate(chat.Completions?.prototype, CHAT);
    patchCreate(responses.Responses?.prototype, RESPONSES);
    patchCreate(embeddings.Embeddings?.prototype, EMBEDDINGS);
    enabled = patches.length > 0;
    return enabled;
  } catch (error) {
    debugLog('openai not installed; capture disabled', error);
    return false;
  }
}

/** Restore originals for tests and explicit opt-out. */
export function disableOpenAICapture(): void {
  for (const patch of patches.splice(0)) patch.target.create = patch.original;
  enabled = false;
}

function patchCreate(target: Record<string, any> | undefined, surface: Surface): void {
  if (!target || typeof target.create !== 'function') return;
  const original = target.create as AnyFunction;
  patches.push({ target, original });
  target.create = function captureOpenAICall(this: any, ...args: any[]): any {
    const ctx = ambientContext();
    const body = isRecord(args[0]) ? args[0] : {};
    const streaming = Boolean(body.stream);
    if (!ctx || suppressesClientCapture() || (streaming && !surface.supportsStreaming)) {
      return original.apply(this, args);
    }

    const span = newCaptureSpan(ctx);
    const requestModel = prefixedModel(PROVIDER, body.model);
    const started = safeEmit(ctx, surface.started(body, requestModel, span));
    let result: any;
    try {
      result = original.apply(this, args);
    } catch (error) {
      void started.then(() => emitFailure(span, requestModel, error));
      throw error;
    }
    return instrumentResult(result, span, requestModel, surface, streaming, started);
  };
}

function instrumentResult(
  result: any,
  span: CaptureSpan,
  requestModel: string,
  surface: Surface,
  streaming: boolean,
  started: Promise<void>,
): any {
  const settle = async (resolve: () => Promise<any>): Promise<any> => {
    await started;
    try {
      const response = await resolve();
      if (streaming && isAsyncIterable(response)) {
        return captureStream(response, span, requestModel, surface);
      }
      const responseError = surface.responseError?.(response);
      if (responseError) {
        await emitFailure(span, requestModel, responseError);
        return response;
      }
      await emitCompleted(span, surface.completed(response, requestModel));
      return response;
    } catch (error) {
      await emitFailure(span, requestModel, error);
      throw error;
    }
  };

  // OpenAI's APIPromise exposes both its response promise and parser as
  // instance fields. HTTP failures reject the response promise before the
  // parser runs, so both stages must be instrumented. Mutating the fields
  // keeps asResponse()/withResponse() and the branded promise surface intact.
  if (result && typeof result.parseResponse === 'function') {
    if (result.responsePromise && typeof result.responsePromise.catch === 'function') {
      result.responsePromise = result.responsePromise.catch(async (error: unknown) => {
        await started;
        await emitFailure(span, requestModel, error);
        throw error;
      });
    }
    const originalParse = result.parseResponse;
    result.parseResponse = (...args: any[]) => settle(() => originalParse.apply(result, args));
    return result;
  }
  if (result && typeof result.then === 'function') {
    return settle(() => result);
  }
  return settle(async () => result);
}

function captureStream(
  inner: AsyncIterable<any>,
  span: CaptureSpan,
  requestModel: string,
  surface: Surface,
): AsyncIterable<any> {
  const state = surface.streamState(requestModel);
  let finished = false;
  const proxy = new Proxy(inner as object, {
    get(target, property, receiver) {
      if (property === Symbol.asyncIterator) {
        return () => {
          const iterator = (target as AsyncIterable<any>)[Symbol.asyncIterator]();
          return {
            async next(...args: []): Promise<IteratorResult<any>> {
              try {
                const item = await iterator.next(...args);
                if (item.done) {
                  if (!finished) {
                    finished = true;
                    if (state.error) await emitFailure(span, state.model ?? requestModel, state.error);
                    else await emitCompleted(span, surface.streamCompleted(state));
                  }
                  return item;
                }
                try {
                  surface.accumulate(state, item.value);
                } catch (error) {
                  debugLog(`${surface.key} stream accumulation failed`, error);
                }
                return item;
              } catch (error) {
                if (!finished) {
                  finished = true;
                  await emitFailure(span, state.model ?? requestModel, error);
                }
                throw error;
              }
            },
            async return(value?: any): Promise<IteratorResult<any>> {
              return iterator.return ? iterator.return(value) : { done: true, value };
            },
            async throw(error?: any): Promise<IteratorResult<any>> {
              if (!finished) {
                finished = true;
                await emitFailure(span, state.model ?? requestModel, error);
              }
              if (iterator.throw) return iterator.throw(error);
              throw error;
            },
          };
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return proxy as AsyncIterable<any>;
}

async function emitCompleted(
  span: CaptureSpan,
  fields: Omit<LMCompletedFields, keyof CaptureSpan | 'source' | 'provider' | 'durationMs'>,
): Promise<void> {
  await safeEmit(span.ctx, buildLMCompleted({
    ...fields,
    source: SOURCE,
    provider: PROVIDER,
    correlationId: span.correlationId,
    parentCorrelationId: span.parentCorrelationId,
    durationMs: elapsedMs(span),
  }));
}

async function emitFailure(span: CaptureSpan, model: string, error: unknown): Promise<void> {
  await safeEmit(span.ctx, buildLMFailed({
    source: SOURCE,
    provider: PROVIDER,
    model,
    correlationId: span.correlationId,
    parentCorrelationId: span.parentCorrelationId,
    durationMs: elapsedMs(span),
    error,
  }));
}

function startedEvent(body: Record<string, any>, model: string, span: CaptureSpan) {
  return buildLMStarted({
    source: SOURCE,
    provider: PROVIDER,
    model,
    correlationId: span.correlationId,
    parentCorrelationId: span.parentCorrelationId,
    messages: contentCaptureEnabled() ? asArray(body.messages ?? body.input) : [],
    systemPrompt: contentCaptureEnabled() ? stringValue(body.instructions) : undefined,
    toolsCount: asArray(body.tools).length,
    temperature: numberValue(body.temperature),
    maxTokens: numberValue(body.max_tokens ?? body.max_output_tokens),
  });
}

const CHAT: Surface = {
  key: 'chat.completions',
  supportsStreaming: true,
  started(body, model, span) {
    return startedEvent(body, model, span);
  },
  completed(response, requestModel) {
    const usage = response?.usage;
    const choice = response?.choices?.[0];
    const message = choice?.message;
    return {
      model: response?.model ? prefixedModel(PROVIDER, response.model) : requestModel,
      inputTokens: integer(usage?.prompt_tokens),
      outputTokens: integer(usage?.completion_tokens),
      totalTokens: integer(usage?.total_tokens),
      cachedTokens: integer(usage?.prompt_tokens_details?.cached_tokens),
      finishReason: stringValue(choice?.finish_reason),
      output: contentCaptureEnabled() ? jsonString(message?.content) : '',
      toolCalls: contentCaptureEnabled() ? message?.tool_calls : undefined,
    };
  },
  streamState: baseStreamState,
  accumulate: accumulateChat,
  streamCompleted: completedStreamFields,
};

const RESPONSES: Surface = {
  key: 'responses',
  supportsStreaming: true,
  started(body, model, span) {
    return startedEvent(body, model, span);
  },
  completed(response, requestModel) {
    return completedResponseFields(response, requestModel);
  },
  responseError(response) {
    const status = String(response?.status ?? '').toLowerCase();
    if (!status || status === 'completed') return undefined;
    return new Error(String(response?.error?.message ?? `response status is ${status}`));
  },
  streamState: baseStreamState,
  accumulate: accumulateResponse,
  streamCompleted: completedResponseStreamFields,
};

const EMBEDDINGS: Surface = {
  key: 'embeddings',
  supportsStreaming: false,
  started(body, model, span) {
    return buildLMStarted({
      source: SOURCE,
      provider: PROVIDER,
      model,
      correlationId: span.correlationId,
      parentCorrelationId: span.parentCorrelationId,
      messages: contentCaptureEnabled() ? [{ role: 'user', content: body.input }] : [],
      toolsCount: 0,
    });
  },
  completed(response, requestModel) {
    const usage = response?.usage;
    const inputTokens = integer(usage?.prompt_tokens);
    return {
      model: response?.model ? prefixedModel(PROVIDER, response.model) : requestModel,
      inputTokens,
      outputTokens: 0,
      totalTokens: integer(usage?.total_tokens) || inputTokens,
      cachedTokens: 0,
      output: contentCaptureEnabled() ? jsonString(response?.data) : '',
    };
  },
  streamState: baseStreamState,
  accumulate() {},
  streamCompleted: completedStreamFields,
};

function baseStreamState(requestModel: string): StreamState {
  return { requestModel, parts: [], toolCalls: new Map() };
}

function accumulateChat(state: StreamState, chunk: any): void {
  if (chunk?.model) state.model = prefixedModel(PROVIDER, chunk.model);
  if (chunk?.usage) state.usage = chunk.usage;
  const choice = chunk?.choices?.[0];
  if (!choice) return;
  if (choice.finish_reason) state.finishReason = String(choice.finish_reason);
  const delta = choice.delta;
  if (typeof delta?.content === 'string') state.parts.push(delta.content);
  for (const call of asArray(delta?.tool_calls)) {
    const index = integer(call?.index);
    const existing = state.toolCalls.get(index) ?? { id: '', type: call?.type ?? 'function', function: { name: '', arguments: '' } };
    if (call?.id) existing.id = `${existing.id ?? ''}${call.id}`;
    const fn = isRecord(existing.function) ? existing.function : { name: '', arguments: '' };
    if (call?.function?.name) fn.name = `${fn.name ?? ''}${call.function.name}`;
    if (call?.function?.arguments) fn.arguments = `${fn.arguments ?? ''}${call.function.arguments}`;
    existing.function = fn;
    state.toolCalls.set(index, existing);
  }
}

function completedStreamFields(state: StreamState) {
  const usage = state.usage;
  const inputTokens = integer(usage?.prompt_tokens ?? usage?.input_tokens);
  const outputTokens = integer(usage?.completion_tokens ?? usage?.output_tokens);
  return {
    model: state.model ?? state.requestModel,
    inputTokens,
    outputTokens,
    totalTokens: integer(usage?.total_tokens) || inputTokens + outputTokens,
    cachedTokens: integer(usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens),
    finishReason: state.finishReason,
    output: contentCaptureEnabled() ? state.parts.join('') : '',
    toolCalls: contentCaptureEnabled() ? [...state.toolCalls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value) : undefined,
  };
}

function completedResponseFields(response: any, requestModel: string) {
  const usage = response?.usage;
  const inputTokens = integer(usage?.input_tokens);
  const outputTokens = integer(usage?.output_tokens);
  return {
    model: response?.model ? prefixedModel(PROVIDER, response.model) : requestModel,
    inputTokens,
    outputTokens,
    totalTokens: integer(usage?.total_tokens) || inputTokens + outputTokens,
    cachedTokens: integer(usage?.input_tokens_details?.cached_tokens),
    finishReason: stringValue(response?.status),
    output: contentCaptureEnabled() ? stringValue(response?.output_text) ?? responseText(response?.output) : '',
    toolCalls: contentCaptureEnabled() ? responseToolCalls(response?.output) : undefined,
  };
}

function accumulateResponse(state: StreamState, event: any): void {
  if (event?.type === 'error' || event?.type === 'response.failed' || event?.type === 'response.incomplete') {
    state.error = new Error(String(event?.error?.message ?? event?.message ?? event?.type));
  }
  if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') {
    state.parts.push(event.delta);
  }
  if (event?.type === 'response.output_item.done' && event.item?.type === 'function_call') {
    state.toolCalls.set(state.toolCalls.size, {
      id: event.item.call_id ?? event.item.id,
      name: event.item.name,
      arguments: event.item.arguments,
    });
  }
  const response = event?.response;
  if (response) {
    state.model = prefixedModel(PROVIDER, response.model);
    state.usage = response.usage;
    state.finishReason = stringValue(response.status);
    if (state.parts.length === 0 && response.output_text) state.parts.push(String(response.output_text));
    for (const call of responseToolCalls(response.output) ?? []) {
      state.toolCalls.set(state.toolCalls.size, call);
    }
  }
}

function completedResponseStreamFields(state: StreamState) {
  const base = completedStreamFields(state);
  return { ...base, output: contentCaptureEnabled() ? state.parts.join('') : '' };
}

function responseText(output: unknown): string {
  const parts: string[] = [];
  for (const item of asArray(output)) {
    for (const content of asArray(item?.content)) {
      if (typeof content?.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('');
}

function responseToolCalls(output: unknown): Record<string, any>[] | undefined {
  const calls = asArray(output)
    .filter((item) => item?.type === 'function_call')
    .map((item) => ({ id: item.call_id ?? item.id, name: item.name, arguments: item.arguments }));
  return calls.length ? calls : undefined;
}

function asArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function numberValue(value: unknown): number | undefined {
  return value == null ? undefined : Number(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<any> {
  return Boolean(value) && typeof (value as AsyncIterable<any>)[Symbol.asyncIterator] === 'function';
}
