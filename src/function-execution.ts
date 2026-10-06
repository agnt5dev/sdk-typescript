import { ActivationKind, ActivationRecoveryPolicy, activationRequestFromContext, runWithActivation } from './activation.js';
import type { ActivationClient, ActivationDecision } from './activation.js';
import { abortable, throwIfAborted } from './cancellation.js';
import { ActivationError, ActivationErrorCode } from './errors.js';
import type { Context, FunctionOptions } from './types.js';
import { isControlFlow } from './control-flow.js';
export { isControlFlow } from './control-flow.js';

function attempts(options: FunctionOptions): number {
  const max = options.retries?.maxAttempts ?? 1;
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('maxAttempts must be a positive integer');
  return max;
}
export function retryDelay(options: FunctionOptions, attempt: number): number {
  const initial = options.retries?.initialIntervalMs ?? 1000;
  const maximum = options.retries?.maxIntervalMs ?? 60000;
  const multiplier = options.backoff?.multiplier ?? 2;
  if (![initial, maximum, multiplier].every(value => Number.isFinite(value) && value >= 0)) throw new RangeError('Retry intervals and multiplier must be finite and non-negative');
  const factor = options.backoff?.type === 'constant' ? 1 : options.backoff?.type === 'linear' ? attempt : multiplier ** (attempt - 1);
  return Math.min(maximum, initial * factor);
}
export async function retrySleep(ms: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await abortable(() => new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }), signal); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Nested function retries share one durable identity and runtime-owned attempts. */
export async function executeFunction<T>(ctx: Context, name: string, input: unknown, options: FunctionOptions, execute: (context: Context) => Promise<T>, canRetry: () => boolean = () => true): Promise<T> {
  const maxAttempts = attempts(options);
  const anyCtx = ctx as Context & { getActivationClient?(): ActivationClient; allocateActivationKey?(kind: string, name: string): string };
  if (maxAttempts > 1 && ctx.metadata?.durable_activation_v1 === 'true') {
    const client = anyCtx.getActivationClient?.();
    const key = anyCtx.allocateActivationKey?.('function', name);
    if (!client || !key) throw new ActivationError(ActivationErrorCode.DurabilityUnavailable, 'nested retries require activation authority');
    const request = await activationRequestFromContext(ctx, {
      kind: ActivationKind.Function, stableKey: key, input,
      recoveryPolicy: ActivationRecoveryPolicy.IdempotentRetry, displayName: name,
    });
    let decision: ActivationDecision | undefined;
    const start = Date.now();
    const { result } = await client.run(request, () => {
      throwIfAborted(ctx.signal);
      return runWithActivation(decision!, () => execute(attemptContext(ctx, decision!.attempt - 1)));
    }, {
      encodeOutput: value => new TextEncoder().encode(JSON.stringify(value ?? null)),
      decodeOutput: value => JSON.parse(new TextDecoder().decode(value)) as T,
      latencyMs: () => Date.now() - start,
      onAdmitted: admitted => { decision = admitted; },
      maxAttempts,
      retryDelay: attempt => retrySleep(retryDelay(options, attempt), ctx.signal),
      failureRetryable: true,
      shouldRetry: canRetry,
      failureErrorCode: 'FUNCTION_FAILED',
    });
    return result;
  }
  for (let attempt = 1; ; attempt++) {
    throwIfAborted(ctx.signal);
    try { return await execute(attemptContext(ctx, attempt - 1)); }
    catch (error) {
      if (attempt >= maxAttempts || !canRetry() || ctx.signal?.aborted || isControlFlow(error)) throw error;
      await retrySleep(retryDelay(options, attempt), ctx.signal);
    }
  }
}

function attemptContext(ctx: Context, attempt: number): Context {
  return new Proxy(ctx, { get(target, key) {
    if (key === 'attempt') return attempt;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
