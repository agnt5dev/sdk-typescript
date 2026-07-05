/**
 * Workflow utilities for parallel execution and orchestration.
 *
 * Phase 4.3: Enhanced workflow capabilities including:
 * - Parallel execution with Promise.all
 * - Gather with named results
 * - Child workflow execution
 * - Enhanced step tracking
 */

import type { Context, WorkflowHandler } from './types.js';
import { WorkflowRegistry } from './workflow.js';

/**
 * Run multiple async tasks in parallel and return results in order.
 *
 * @param tasks - Array of promises to execute in parallel
 * @returns Array of results in the same order as tasks
 *
 * @example
 * ```typescript
 * const [result1, result2, result3] = await parallel([
 *   fetchUser(userId),
 *   fetchOrders(userId),
 *   fetchSettings(userId),
 * ]);
 * ```
 */
export async function parallel<T extends readonly unknown[] | []>(
  tasks: T
): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  return Promise.all(tasks) as any;
}

/**
 * Run tasks in parallel with named results.
 *
 * @param tasks - Object with task names as keys and promises as values
 * @returns Object with same keys and resolved values
 *
 * @example
 * ```typescript
 * const results = await gather({
 *   user: fetchUser(userId),
 *   orders: fetchOrders(userId),
 *   settings: fetchSettings(userId),
 * });
 * // results.user, results.orders, results.settings
 * ```
 */
export async function gather<T extends Record<string, Promise<any>>>(
  tasks: T
): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const keys = Object.keys(tasks);
  const promises = Object.values(tasks);

  const results = await Promise.all(promises);

  const resultObj: any = {};
  for (let i = 0; i < keys.length; i++) {
    resultObj[keys[i]] = results[i];
  }

  return resultObj;
}

/**
 * Execute a child workflow from within a parent workflow.
 *
 * @param ctx - Parent workflow context
 * @param workflowNameOrHandler - Workflow name or handler function
 * @param input - Input data for the child workflow
 * @returns Result from the child workflow
 *
 * @example
 * ```typescript
 * const processOrder = workflow('process-order', async (ctx, orderId) => {
 *   // Execute child workflow
 *   const validation = await executeChildWorkflow(ctx, 'validate-order', orderId);
 *
 *   if (!validation.valid) {
 *     throw new Error('Invalid order');
 *   }
 *
 *   return { status: 'processed' };
 * });
 * ```
 */
export async function executeChildWorkflow<TInput = any, TOutput = any>(
  ctx: Context,
  workflowNameOrHandler: string | WorkflowHandler<TInput, TOutput>,
  input: TInput
): Promise<TOutput> {
  let workflowName: string;
  let handler: WorkflowHandler<TInput, TOutput>;

  // Resolve workflow handler
  if (typeof workflowNameOrHandler === 'string') {
    workflowName = workflowNameOrHandler;
    const config = WorkflowRegistry.get(workflowName);
    if (!config) {
      throw new Error(`Workflow '${workflowName}' not found in registry`);
    }
    handler = config.handler as WorkflowHandler<TInput, TOutput>;
  } else {
    handler = workflowNameOrHandler;
    workflowName = (handler as any).name || 'anonymous-child-workflow';
  }

  ctx.logger.info(`Starting child workflow: ${workflowName}`);

  try {
    // Execute child workflow with parent context
    const result = await handler(ctx, input);
    ctx.logger.info(`Child workflow completed: ${workflowName}`);
    return result;
  } catch (error) {
    ctx.logger.error(`Child workflow failed: ${workflowName}`, { error: (error as Error).message });
    throw error;
  }
}

/**
 * Execute multiple child workflows in parallel.
 *
 * @param ctx - Parent workflow context
 * @param workflows - Array of [workflowNameOrHandler, input] tuples
 * @returns Array of results from child workflows
 *
 * @example
 * ```typescript
 * const results = await parallelWorkflows(ctx, [
 *   ['validate-user', userId],
 *   ['validate-payment', paymentId],
 *   ['validate-inventory', items],
 * ]);
 * ```
 */
export async function parallelWorkflows<T = any>(
  ctx: Context,
  workflows: Array<[string | WorkflowHandler, any]>
): Promise<T[]> {
  const tasks = workflows.map(([nameOrHandler, input]) =>
    executeChildWorkflow(ctx, nameOrHandler, input)
  );
  return parallel(tasks);
}

/**
 * Execute child workflows with named results.
 *
 * @param ctx - Parent workflow context
 * @param workflows - Object with workflow names as keys and [nameOrHandler, input] as values
 * @returns Object with same keys and workflow results
 *
 * @example
 * ```typescript
 * const results = await gatherWorkflows(ctx, {
 *   user: ['validate-user', userId],
 *   payment: ['validate-payment', paymentId],
 *   inventory: ['check-inventory', items],
 * });
 * // results.user, results.payment, results.inventory
 * ```
 */
export async function gatherWorkflows<T extends Record<string, [string | WorkflowHandler, any]>>(
  ctx: Context,
  workflows: T
): Promise<{ [K in keyof T]: any }> {
  const tasks: Record<string, Promise<any>> = {};

  for (const [key, [nameOrHandler, input]] of Object.entries(workflows)) {
    tasks[key] = executeChildWorkflow(ctx, nameOrHandler, input);
  }

  return gather(tasks) as Promise<{ [K in keyof T]: any }>;
}

/**
 * Fan-out pattern: Execute the same workflow with different inputs in parallel.
 *
 * @param ctx - Parent workflow context
 * @param workflowNameOrHandler - Workflow to execute
 * @param inputs - Array of inputs for each workflow execution
 * @returns Array of results
 *
 * @example
 * ```typescript
 * const userIds = [1, 2, 3, 4, 5];
 * const results = await fanOut(ctx, 'process-user', userIds);
 * ```
 */
export async function fanOut<TInput = any, TOutput = any>(
  ctx: Context,
  workflowNameOrHandler: string | WorkflowHandler<TInput, TOutput>,
  inputs: TInput[]
): Promise<TOutput[]> {
  const tasks = inputs.map(input => executeChildWorkflow(ctx, workflowNameOrHandler, input));
  return parallel(tasks);
}

/**
 * Execute workflows in batches to avoid overwhelming the system.
 *
 * @param ctx - Parent workflow context
 * @param workflowNameOrHandler - Workflow to execute
 * @param inputs - Array of inputs for each workflow execution
 * @param batchSize - Number of workflows to execute in parallel per batch (default: 10)
 * @returns Array of results
 *
 * @example
 * ```typescript
 * const userIds = Array.from({ length: 100 }, (_, i) => i);
 * const results = await batchExecute(ctx, 'process-user', userIds, 10);
 * // Processes 100 users in batches of 10
 * ```
 */
export async function batchExecute<TInput = any, TOutput = any>(
  ctx: Context,
  workflowNameOrHandler: string | WorkflowHandler<TInput, TOutput>,
  inputs: TInput[],
  batchSize: number = 10
): Promise<TOutput[]> {
  const results: TOutput[] = [];

  for (let i = 0; i < inputs.length; i += batchSize) {
    const batch = inputs.slice(i, i + batchSize);
    ctx.logger.info(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(inputs.length / batchSize)}`);

    const batchResults = await fanOut(ctx, workflowNameOrHandler, batch);
    results.push(...batchResults);
  }

  return results;
}

/**
 * Race pattern: Return the first workflow that completes successfully.
 *
 * @param ctx - Parent workflow context
 * @param workflows - Array of [workflowNameOrHandler, input] tuples
 * @returns Result from the first workflow to complete
 *
 * @example
 * ```typescript
 * const result = await race(ctx, [
 *   ['fetch-from-cache', cacheKey],
 *   ['fetch-from-db', dbId],
 *   ['fetch-from-api', apiUrl],
 * ]);
 * // Returns whichever completes first
 * ```
 */
export async function race<T = any>(
  ctx: Context,
  workflows: Array<[string | WorkflowHandler, any]>
): Promise<T> {
  const tasks = workflows.map(([nameOrHandler, input]) =>
    executeChildWorkflow(ctx, nameOrHandler, input)
  );
  return Promise.race(tasks);
}

/**
 * Execute workflows with a timeout.
 *
 * @param ctx - Parent workflow context
 * @param workflowNameOrHandler - Workflow to execute
 * @param input - Input data for the workflow
 * @param timeoutMs - Timeout in milliseconds
 * @returns Result from the workflow
 * @throws TimeoutError if workflow exceeds timeout
 *
 * @example
 * ```typescript
 * try {
 *   const result = await withTimeout(ctx, 'slow-workflow', input, 5000);
 * } catch (error) {
 *   if (error instanceof TimeoutError) {
 *     // Handle timeout
 *   }
 * }
 * ```
 */
export async function withTimeout<TInput = any, TOutput = any>(
  ctx: Context,
  workflowNameOrHandler: string | WorkflowHandler<TInput, TOutput>,
  input: TInput,
  timeoutMs: number
): Promise<TOutput> {
  const { TimeoutError } = await import('./errors.js');

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new TimeoutError(`Workflow execution timed out after ${timeoutMs}ms`, timeoutMs, 'withTimeout'));
    }, timeoutMs);
  });

  const workflowPromise = executeChildWorkflow(ctx, workflowNameOrHandler, input);

  return Promise.race([workflowPromise, timeoutPromise]);
}

/**
 * Saga pattern coordinator for managing compensating transactions.
 *
 * Executes steps sequentially, and if any step fails, executes compensating
 * actions in reverse order.
 *
 * @param ctx - Workflow context
 * @param steps - Array of [action, compensation] tuples
 * @returns Result from the final step
 * @throws Error from failed step after compensation
 *
 * @example
 * ```typescript
 * const result = await saga(ctx, [
 *   [
 *     async () => await reserveInventory(items),
 *     async () => await releaseInventory(items),
 *   ],
 *   [
 *     async () => await chargePayment(paymentInfo),
 *     async () => await refundPayment(paymentInfo),
 *   ],
 *   [
 *     async () => await shipOrder(orderId),
 *     async () => await cancelShipment(orderId),
 *   ],
 * ]);
 * ```
 */
export async function saga<T = any>(
  ctx: Context,
  steps: Array<[() => Promise<T>, () => Promise<void>]>
): Promise<T> {
  const completedSteps: Array<() => Promise<void>> = [];
  let lastResult: T | undefined;

  try {
    for (let i = 0; i < steps.length; i++) {
      const [action, compensation] = steps[i];

      ctx.logger.info(`Executing saga step ${i + 1}/${steps.length}`);
      lastResult = await action();

      completedSteps.push(compensation);
    }

    return lastResult!;
  } catch (error) {
    ctx.logger.error(`Saga failed at step ${completedSteps.length + 1}, executing compensations`);

    // Execute compensations in reverse order
    for (let i = completedSteps.length - 1; i >= 0; i--) {
      try {
        ctx.logger.info(`Executing compensation ${i + 1}/${completedSteps.length}`);
        await completedSteps[i]();
      } catch (compensationError) {
        ctx.logger.error(`Compensation ${i + 1} failed: ${(compensationError as Error).message}`);
      }
    }

    throw error;
  }
}

/**
 * Retry a workflow with exponential backoff.
 *
 * @param ctx - Workflow context
 * @param workflowNameOrHandler - Workflow to execute
 * @param input - Input data for the workflow
 * @param maxAttempts - Maximum number of attempts (default: 3)
 * @param initialDelayMs - Initial delay in milliseconds (default: 1000)
 * @returns Result from the workflow
 *
 * @example
 * ```typescript
 * const result = await retryWorkflow(
 *   ctx,
 *   'unstable-api-call',
 *   apiParams,
 *   5,    // 5 attempts
 *   2000  // Start with 2 second delay
 * );
 * ```
 */
/**
 * Durable sleep that survives workflow restarts.
 *
 * Unlike `setTimeout` or `new Promise(resolve => setTimeout(...))`, this sleep
 * is checkpointed via `ctx.step()`. If the workflow crashes and restarts, it
 * only sleeps for the remaining duration (or skips entirely if the period has
 * already elapsed).
 *
 * @param ctx - Workflow context
 * @param durationMs - Duration to sleep in milliseconds
 * @param name - Optional name for the sleep checkpoint (auto-generated if omitted)
 *
 * @example
 * ```typescript
 * const notifyLater = workflow('notify-later', async (ctx, userId) => {
 *   await ctx.step('send-ack', () => sendAck(userId));
 *
 *   // Wait 24 hours (survives restarts!)
 *   await sleep(ctx, 24 * 60 * 60 * 1000, 'wait_24h');
 *
 *   await ctx.step('send-followup', () => sendFollowup(userId));
 * });
 * ```
 */
export async function sleep(
  ctx: Context,
  durationMs: number,
  name?: string,
): Promise<void> {
  await ctx.sleep(durationMs, name);
}

export async function retryWorkflow<TInput = any, TOutput = any>(
  ctx: Context,
  workflowNameOrHandler: string | WorkflowHandler<TInput, TOutput>,
  input: TInput,
  maxAttempts: number = 3,
  initialDelayMs: number = 1000
): Promise<TOutput> {
  const { executeWithRetry } = await import('./retry-utils.js');

  return executeWithRetry(
    () => executeChildWorkflow(ctx, workflowNameOrHandler, input),
    {
      retryPolicy: { maxAttempts, initialIntervalMs: initialDelayMs, maxIntervalMs: 60000 },
      backoffPolicy: 'exponential',
      jitter: true,
      context: ctx,
    }
  );
}
