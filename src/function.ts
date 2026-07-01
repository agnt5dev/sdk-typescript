import type {
  Context,
  FunctionHandler,
  RetryPolicy,
  BackoffPolicy,
} from './types';
import {
  functionCompleted,
  functionFailed,
  functionStarted,
  generateCid,
  workflowStepCompleted,
  workflowStepFailed,
  workflowStepStarted,
} from './events.js';
import { FunctionRegistry } from './function-registry.js';
import type { FunctionOptions } from './types.js';

/**
 * Function builder for creating durable functions
 * @template TInput - Input parameter types
 * @template TOutput - Return type
 */
export class FunctionBuilder<TInput = any, TOutput = any> {
  private config: FunctionOptions = {};

  constructor(private name: string) {}

  /**
   * Configure retry policy
   */
  retry(policy: RetryPolicy): this {
    this.config.retries = policy;
    return this;
  }

  /**
   * Configure backoff strategy
   */
  backoff(policy: BackoffPolicy): this {
    this.config.backoff = policy;
    return this;
  }

  /**
   * Configure timeout in milliseconds
   */
  timeout(ms: number): this {
    this.config.timeout_ms = ms;
    return this;
  }

  /**
   * Define the function handler.
   *
   * The handler is registered as-is for top-level dispatch (the worker's
   * function dispatch path at worker.ts emits function.started/completed
   * around it). For nested invocations from a workflow body, the *returned*
   * function is a wrapper that emits the full Python-parity event chain:
   *
   *   workflow.step.started (parent=workflow_cid)
   *     function.started    (parent=step_cid)
   *       handler runs
   *     function.completed  (parent=step_cid)
   *   workflow.step.completed (parent=workflow_cid)
   *
   * The wrapper detects a platform Context by sniffing for `emit` +
   * correlation-stack methods; when called without one (e.g. unit tests),
   * it falls through to the raw handler.
   */
  run(handler: FunctionHandler<TInput, TOutput>): FunctionHandler<TInput, TOutput> {
    FunctionRegistry.register(this.name, {
      handler,
      options: this.config,
    });

    const handlerName = this.name;

    const wrapped = async (ctx: Context, ...args: TInput[]): Promise<TOutput> => {
      const anyCtx = ctx as any;
      const hasEmit = ctx && typeof anyCtx.emit === 'function';
      const hasStack = ctx && typeof anyCtx.pushCorrelation === 'function';

      // No platform context — call handler directly (unit tests, local invocation).
      if (!hasEmit || !hasStack) {
        return handler(ctx, ...args);
      }

      // Skip event emission when the dispatcher is already wrapping us. This
      // shows up when a function (not a workflow) is the top-level dispatch
      // target: worker.ts emits function.started around fn.handler(ctx, ...),
      // and that handler is the *raw* one from the registry — so the wrapper
      // never executes in that path. The check below covers the symmetric
      // case where someone manually invokes the wrapper as the top-level
      // entry without a parent context.
      const parentCid: string | undefined =
        anyCtx.getCurrentCorrelationId?.() ?? anyCtx._workflowCid;
      if (!parentCid) {
        return handler(ctx, ...args);
      }

      const stepName: string = anyCtx.nextStepName?.(handlerName) ?? `${handlerName}_0`;
      const stepCid = generateCid();
      const fnCid = generateCid();
      const startMs = Date.now();

      // Event metadata: single-arg handlers (the common case) emit the bare
      // value to match sdk-python's shape; multi-arg handlers emit the full
      // arg list so nothing is dropped from the journal.
      const inputForEvent: any = args.length <= 1 ? args[0] : args;

      await ctx.emit(
        workflowStepStarted(stepCid, parentCid, {
          handlerName,
          stepName,
          input: inputForEvent,
          attempt: 1,
        }),
      );
      await ctx.emit(
        functionStarted(fnCid, stepCid, {
          inputData: inputForEvent,
          attempt: 0,
        }),
      );

      // Push function cid so any nested Agent.run/lm event inherits fnCid
      // as its parent (matches sdk-python: function → agent.started).
      anyCtx.pushCorrelation(fnCid);
      try {
        const result = await handler(ctx, ...args);
        const durationMs = Date.now() - startMs;

        await ctx.emit(
          functionCompleted(fnCid, stepCid, {
            outputData: result,
            durationMs,
          }),
        );
        await ctx.emit(
          workflowStepCompleted(stepCid, parentCid, {
            handlerName,
            stepName,
            result,
            durationMs,
          }),
        );
        return result;
      } catch (err) {
        const durationMs = Date.now() - startMs;
        const errorMessage = (err as Error).message ?? String(err);

        await ctx.emit(
          functionFailed(fnCid, stepCid, {
            errorCode: 'FUNCTION_ERROR',
            errorMessage,
            durationMs,
          }),
        );
        await ctx.emit(
          workflowStepFailed(stepCid, parentCid, {
            stepName,
            errorCode: 'FUNCTION_ERROR',
            errorMessage,
            durationMs,
          }),
        );
        throw err;
      } finally {
        anyCtx.popCorrelation();
      }
    };

    return wrapped as FunctionHandler<TInput, TOutput>;
  }
}

/**
 * Create a new function builder
 * @param name - Unique function name
 * @returns Function builder instance
 *
 * @example
 * ```typescript
 * const greet = fn('greet').run(async (ctx, name: string) => {
 *   return `Hello, ${name}!`;
 * });
 * ```
 */
export function fn<TInput = any, TOutput = any>(
  name: string
): FunctionBuilder<TInput, TOutput> {
  return new FunctionBuilder<TInput, TOutput>(name);
}

export { FunctionRegistry };
