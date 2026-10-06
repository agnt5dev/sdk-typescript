import type { Context } from './types.js';
import { abortable } from './cancellation.js';
import { trackWorkflowStream } from './step-scope.js';
import { canonicalActivationValue } from './activation.js';
import { ActivationError, ActivationErrorCode } from './errors.js';

type Operation = 'next' | 'throw' | 'return';
type StreamRecord = { operation: Operation; argumentSignature: string; result: IteratorResult<unknown> };
type Output<T> = { kind: 'value'; value: T } | { kind: 'stream'; records: StreamRecord[] };

/** Error stacks vary on replay; preserve their semantic fields and custom data. */
function iteratorArgumentSignature(value: unknown, ancestors = new Set<object>()): string {
  if (value === undefined) return '["undefined"]';
  if (value && typeof value === 'object') {
    if (ancestors.has(value)) throw new ActivationError(ActivationErrorCode.InvalidArgument, 'Streaming function iterator arguments must not contain cycles');
    ancestors.add(value);
    const signature = (nested: unknown) => iteratorArgumentSignature(nested, ancestors);
    try {
      if (value instanceof Error) {
        const properties = Object.getOwnPropertyNames(value).filter(key => !['stack', 'name', 'message', 'cause'].includes(key)).sort()
          .map(key => [key, signature((value as unknown as Record<string, unknown>)[key])]);
        return JSON.stringify(['error', value.constructor.name, value.name, value.message,
          signature((value as Error & { cause?: unknown }).cause), properties]);
      }
      if (Array.isArray(value)) return JSON.stringify(['array', value.map(signature)]);
      if ([Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        return JSON.stringify(['object', Object.keys(value).sort().map(key => [key, signature((value as Record<string, unknown>)[key])])]);
      }
    } finally { ancestors.delete(value); }
  }
  return new TextDecoder().decode(canonicalActivationValue(value));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Keep a step admitted until its live iterator finishes, then checkpoint its protocol. */
export async function checkpointFunctionOutput<T>(
  ctx: Context,
  name: string,
  input: unknown,
  execute: (consume: (value: T) => Promise<Output<T>>, canRetry: () => boolean) => Promise<Output<T>>,
): Promise<T> {
  const delivered = deferred<T>();
  let live = false;
  let releaseStream: (() => void) | undefined;
  let closed = false;
  let failed = false;
  let failure: unknown;
  let finalReply: (() => void) | undefined;
  type Request = { operation: Operation; argument: unknown; reply: ReturnType<typeof deferred<IteratorResult<unknown>>> };
  const requests: Request[] = [];
  let wake = deferred<void>();
  let active: Request | undefined;
  let iterator: AsyncIterator<unknown> | undefined;
  const send = (operation: Operation, argument?: unknown): Promise<IteratorResult<unknown>> => {
    if (failed) return Promise.reject(failure);
    if (closed) return operation === 'throw' ? Promise.reject(argument) : Promise.resolve({ done: true, value: operation === 'return' ? argument : undefined });
    const reply = deferred<IteratorResult<unknown>>();
    requests.push({ operation, argument, reply });
    wake.resolve();
    return reply.promise;
  };
  const checkpoint = ctx.step(name, () => execute(async value => {
    if (!value || typeof (value as any)[Symbol.asyncIterator] !== 'function') return { kind: 'value', value };
    iterator = (value as unknown as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    live = true;
    releaseStream = trackWorkflowStream(ctx);
    delivered.resolve({
      next: (argument?: unknown) => send('next', argument),
      throw: (error?: unknown) => send('throw', error),
      return: (argument?: unknown) => send('return', argument),
      [Symbol.asyncIterator]() { return this; },
    } as T);
    const records: StreamRecord[] = [];
    while (true) {
      if (!requests.length) await abortable(() => wake.promise, ctx.signal);
      wake = deferred<void>();
      active = requests.shift()!;
      const argumentSignature = iteratorArgumentSignature(active.argument);
      const method = iterator![active.operation];
      let result: IteratorResult<unknown>;
      if (method) result = await method.call(iterator, active.argument);
      else if (active.operation === 'throw') throw active.argument;
      else result = { done: true, value: active.argument };
      records.push({ operation: active.operation, argumentSignature, result });
      if (result.done) {
        // Final next()/return() resolves only after the checkpoint is acknowledged.
        finalReply = () => active!.reply.resolve(result);
        return { kind: 'stream', records };
      }
      active.reply.resolve(result);
      active = undefined;
    }
  }, () => !live), { input });
  void checkpoint.then(output => {
    releaseStream?.();
    closed = true;
    if (live) finalReply?.();
    else if (output.kind === 'value') delivered.resolve(output.value);
    else {
      let index = 0;
      const replay = async (operation: Operation, argument?: unknown): Promise<IteratorResult<unknown>> => {
        const record = output.records[index];
        if (!record) {
          if (operation === 'throw') throw argument;
          return { done: true, value: operation === 'return' ? argument : undefined };
        }
        if (record.operation !== operation) throw new ActivationError(ActivationErrorCode.NonDeterministicReplay, 'Streaming function replay changed iterator operations');
        if (record.argumentSignature !== iteratorArgumentSignature(argument)) throw new ActivationError(ActivationErrorCode.NonDeterministicReplay, 'Streaming function replay changed iterator arguments');
        index++;
        return record.result;
      };
      delivered.resolve({
        next: (value?: unknown) => replay('next', value),
        throw: (error?: unknown) => replay('throw', error),
        return: (value?: unknown) => replay('return', value),
        [Symbol.asyncIterator]() { return this; },
      } as T);
    }
    for (const request of requests) request.reply.resolve({ done: true, value: undefined });
  }, error => {
    releaseStream?.();
    failed = true; failure = error;
    void iterator?.return?.().catch(cleanupError => console.error('Stream cleanup failed', cleanupError));
    active?.reply.reject(error);
    for (const request of requests) request.reply.reject(error);
    delivered.reject(error);
  });
  return delivered.promise;
}
