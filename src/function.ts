import { checkpointFunctionOutput } from './checkpoint-output.js';
import type {
  Context,
  FunctionHandler,
  JSONSchema,
  RetryPolicy,
  BackoffPolicy,
} from './types.js';
import type { WorkerlessFlowControlPolicy } from './flow-control.js';
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
import { withSpan } from './tracing.js';
import type { FunctionOptions } from './types.js';
import { executeFunction } from './function-execution.js';
import { inWorkflowStep, runInWorkflowStep } from './step-scope.js';

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

  /** Describe what the function does (the description of an MCP tool that publishes it). */
  description(text: string): this {
    this.config.description = text;
    return this;
  }

  /**
   * Declare the function input schema used by Studio, manifests, and runtime
   * registration. TypeScript types are erased at runtime, so structured
   * inputs must provide a JSON Schema explicitly.
   */
  inputSchema(schema: JSONSchema): this {
    this.config.inputSchema = schema;
    return this;
  }

  /** Declare the function output schema used by registration and manifests. */
  outputSchema(schema: JSONSchema): this {
    this.config.outputSchema = schema;
    return this;
  }

  /**
   * Declare workerless flow-control policy for generated manifests.
   */
  flowControl(policy: WorkerlessFlowControlPolicy): this {
    this.config.flowControl = policy;
    return this;
  }

  /**
   * Declare a static scheduling priority for generated manifests.
   */
  priority(priority: number): this {
    this.config.priority = priority;
    return this;
  }

  /**
   * Declare a static active concurrency limit for generated manifests.
   */
  maxConcurrency(limit: number): this {
    this.config.maxConcurrency = limit;
    return this;
  }

  /**
   * Define the function handler.
   *
   * The handler is registered as-is for top-level dispatch (the worker's
   * function dispatch path at worker.ts emits function.started/completed
   * around it). For nested invocations from a workflow body, the *returned*
   * function is a wrapper that emits its function lifecycle. On the legacy
   * workflow path it also owns a decorative step boundary:
   *
   *   workflow.step.started (parent=workflow_cid)
   *     function.started    (parent=step_cid)
   *       handler runs
   *     function.completed  (parent=step_cid)
   *   workflow.step.completed (parent=workflow_cid)
   *
   * A durable `ctx.step` is different: the runtime already journals the
   * authoritative `workflow.step.*` activation records. In that scope the
   * wrapper emits only `function.*`, parented to the activation id, so one
   * logical step never appears as two step lifecycles.
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

    const lifecycle = async (ctx: Context, ...args: TInput[]): Promise<TOutput> => {
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

      const activationId: string | undefined = anyCtx.activation?.activationId;
      const ownsStepBoundary = !activationId && !inWorkflowStep();
      const stepName: string | undefined = ownsStepBoundary
        ? anyCtx.nextStepName?.(handlerName) ?? `${handlerName}_0`
        : undefined;
      const stepCid: string | undefined = ownsStepBoundary ? generateCid() : undefined;
      const functionParentCid = activationId ?? stepCid ?? parentCid;
      const fnCid = generateCid();
      const startMs = Date.now();

      // Event metadata: single-arg handlers (the common case) emit the bare
      // value to match sdk-python's shape; multi-arg handlers emit the full
      // arg list so nothing is dropped from the journal.
      const inputForEvent: any = args.length <= 1 ? args[0] : args;

      if (ownsStepBoundary && stepCid && stepName) {
        await ctx.emit(
          workflowStepStarted(stepCid, parentCid, {
            handlerName,
            stepName,
            input: inputForEvent,
            attempt: 1,
          }),
        );
      }
      await ctx.emit(
        functionStarted(fnCid, functionParentCid, {
          inputData: inputForEvent,
          attempt: ctx.attempt ?? 0,
          componentName: handlerName,
        }),
      );

      const hasTaskLocalCorrelation =
        typeof anyCtx.runWithCorrelation === 'function';
      if (!hasTaskLocalCorrelation) {
        anyCtx.pushCorrelation(fnCid);
      }
      // ctx.progress inside this function sits where its lifecycle does.
      anyCtx.registerCorrelationScope?.(fnCid, { name: handlerName, parentCorrelationId: functionParentCid });
      try {
        const invokeHandler = () =>
          withSpan(`function.${handlerName}`, () => handler(ctx, ...args), {
            componentType: 'function',
            attributes: { run_id: ctx.runId, handler_name: handlerName },
            followAsyncIterable: true,
          });
        const result = hasTaskLocalCorrelation
          ? await anyCtx.runWithCorrelation(fnCid, invokeHandler)
          : await invokeHandler();
        const durationMs = Date.now() - startMs;

        await ctx.emit(
          functionCompleted(fnCid, functionParentCid, {
            outputData: result,
            durationMs,
            componentName: handlerName,
          }),
        );
        if (ownsStepBoundary && stepCid && stepName) {
          await ctx.emit(
            workflowStepCompleted(stepCid, parentCid, {
              handlerName,
              stepName,
              result,
              durationMs,
            }),
          );
        }
        return result;
      } catch (err) {
        const durationMs = Date.now() - startMs;
        const errorMessage = (err as Error).message ?? String(err);

        await ctx.emit(
          functionFailed(fnCid, functionParentCid, {
            errorCode: 'FUNCTION_ERROR',
            errorMessage,
            durationMs,
            componentName: handlerName,
          }),
        );
        if (ownsStepBoundary && stepCid && stepName) {
          await ctx.emit(
            workflowStepFailed(stepCid, parentCid, {
              stepName,
              errorCode: 'FUNCTION_ERROR',
              errorMessage,
              durationMs,
            }),
          );
        }
        throw err;
      } finally {
        anyCtx.unregisterCorrelationScope?.(fnCid);
        if (!hasTaskLocalCorrelation) {
          anyCtx.popCorrelation();
        }
      }
    };

    const wrapped = async (ctx: Context, ...args: TInput[]): Promise<TOutput> => {
      const anyCtx = ctx as any;
      const checkpointed = !inWorkflowStep() && !anyCtx.activation && typeof ctx?.step === 'function' &&
        (ctx.metadata?.component_type === 'workflow' || anyCtx._workflowCid);
      if (!checkpointed) {
        return executeFunction(ctx, handlerName, args, this.config,
          (attemptCtx, input) => lifecycle(attemptCtx, ...(input as TInput[])));
      }
      const name = anyCtx.nextStepName?.(handlerName) ?? anyCtx.allocateActivationKey?.('function-step', handlerName) ?? handlerName;
      return checkpointFunctionOutput<TOutput>(ctx, name, args, (consume, canRetry) =>
        runInWorkflowStep(() => executeFunction(ctx, handlerName, args, this.config,
          async (attemptCtx, input) => consume(await lifecycle(attemptCtx, ...(input as TInput[]))), canRetry)));

    };

    (wrapped as any)._agnt5_config = {
      name: handlerName,
      handler,
      options: this.config,
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
