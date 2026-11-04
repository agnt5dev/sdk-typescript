/** Workflow-local steps backed by one activation, without function checkpoints. */
import type { BackoffPolicy, Context, RetryPolicy, StepOptions } from './types.js';
import { ActivationClient, runWithActivation, stepActivationRequest } from './activation.js';
import type { ActivationDecision, ActivationExecution } from './activation.js';
import { ActivationError, ActivationErrorCode } from './errors.js';
import { abortable, combineSignals, throwIfAborted } from './cancellation.js';
import { retryDelay, retrySleep } from './function-execution.js';
import { normalizeStepInput } from './step-input.js';
import { getCurrentContext, runWithContext } from './async-context.js';
import { runInWorkflowStep } from './step-scope.js';

const definition = Symbol('agnt5.declared-step');

export interface StepContext extends Context {
  readonly activation: ActivationExecution;
}

export interface DeclaredStepOptions {
  retries?: RetryPolicy;
  backoff?: BackoffPolicy;
  /** Timeout of each handler attempt, excluding admission/completion ACKs. */
  timeoutMs?: number;
}

export interface DeclaredStep<I, O> {
  readonly name: string;
  readonly [definition]: {
    handler: (ctx: StepContext, input: I) => O | Promise<O>;
    options: Readonly<DeclaredStepOptions>;
  };
}

/** Declare a step; invoke with ctx.step(declaration, { input, key }). */
export function step<I = void, O = unknown>(
  name: string,
  handler: (ctx: StepContext, input: I) => O | Promise<O>,
  options: DeclaredStepOptions = {},
): DeclaredStep<I, O> {
  if (!name.trim()) throw new RangeError('step name must not be empty');
  if (typeof handler !== 'function') throw new TypeError('step requires a handler');
  const maxAttempts = options.retries?.maxAttempts ?? 1;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new RangeError('maxAttempts must be a positive integer');
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) {
    throw new RangeError('timeoutMs must be a positive integer');
  }
  retryDelay(options, 1);
  const policy = Object.freeze({ ...options,
    retries: options.retries && Object.freeze({ ...options.retries }),
    backoff: options.backoff && Object.freeze({ ...options.backoff }),
  });
  return Object.freeze({ name, [definition]: Object.freeze({ handler, options: policy }) });
}

export function isDeclaredStep(value: unknown): value is DeclaredStep<any, any> {
  return !!value && typeof value === 'object' && definition in value;
}

type ActivationContext = Context & {
  getActivationClient?(): ActivationClient | undefined;
  runWithCorrelation?<T>(cid: string, fn: () => T | Promise<T>): T | Promise<T>;
};

export async function runDeclaredStep<I, O>(
  context: Context, declared: DeclaredStep<I, O>, options: StepOptions<I> | undefined, ordinal: number,
): Promise<{ result: O; stableKey: string }> {
  if (!isDeclaredStep(declared)) throw new TypeError('ctx.step requires a declared step');
  const ctx = context as ActivationContext;
  const client = ctx.getActivationClient?.();
  if (!client) throw new ActivationError(ActivationErrorCode.DurabilityUnavailable, 'declared steps require runtime durable activation support');
  const { handler, options: policy } = declared[definition];
  const snapshot = normalizeStepInput(options?.input);
  if (snapshot === undefined && (handler.length > 1 || Object.prototype.hasOwnProperty.call(options ?? {}, 'input'))) {
    throw new ActivationError(ActivationErrorCode.InvalidArgument, 'declared step input must be supplied and must not be undefined');
  }
  const request = await stepActivationRequest({ metadata: ctx.metadata ?? {}, invocationId: ctx.invocationId,
    runId: ctx.runId, componentName: ctx.metadata?.component_name || ctx.serviceName,
    stepName: declared.name, ordinal, explicitKey: options?.key, input: snapshot });
  let admitted: ActivationDecision | undefined;
  const started = Date.now();
  const checkCancellation = () => {
    if (ctx.signal.aborted) throw new ActivationError(ActivationErrorCode.Cancelled, 'step invocation was cancelled');
  };
  const { result } = await abortable(() => client.run<O>(request, async () => {
    checkCancellation();
    if (!admitted) throw new ActivationError(ActivationErrorCode.UnknownOutcome, 'step executed without admitted authority');
    const decision = admitted;
    return runWithActivation(decision, async () => {
      const timeout = new AbortController();
      const combined = combineSignals(ctx.signal, timeout.signal);
      const scoped = Object.create(ctx) as StepContext;
      Object.defineProperties(scoped, {
        attempt: { value: decision.attempt - 1 }, signal: { value: combined.signal },
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (policy.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const error = new Error(`Step '${declared.name}' timed out`);
          error.name = 'TimeoutError';
          timeout.abort(error);
        }, policy.timeoutMs);
      }
      try {
        const execute = () => runInWorkflowStep(() => runWithContext({ ...getCurrentContext(),
          runId: ctx.runId, correlationId: decision.activationId, executionContext: scoped,
          getCorrelationId: () => decision.activationId,
        }, () => handler(scoped, normalizeStepInput(snapshot) as I)));
        const value = await abortable(() => ctx.runWithCorrelation
          ? ctx.runWithCorrelation(decision.activationId, execute) : execute(), combined.signal);
        checkCancellation();
        return value;
      } catch (error) {
        checkCancellation();
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        combined.dispose();
      }
    });
  }, {
    encodeOutput: value => {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) throw new ActivationError(ActivationErrorCode.InvalidArgument, 'step output must be JSON serializable; return null instead of undefined');
      return new TextEncoder().encode(encoded);
    },
    decodeOutput: value => JSON.parse(new TextDecoder().decode(value)) as O,
    latencyMs: () => Date.now() - started,
    onAdmitted: decision => { checkCancellation(); admitted = decision; },
    maxAttempts: policy.retries?.maxAttempts ?? 1,
    failureRetryable: (policy.retries?.maxAttempts ?? 1) > 1,
    retryDelay: attempt => retrySleep(retryDelay(policy, attempt), ctx.signal),
    shouldRetry: () => !ctx.signal.aborted,
  }), ctx.signal);
  throwIfAborted(ctx.signal);
  return { result, stableKey: request.stableKey };
}
