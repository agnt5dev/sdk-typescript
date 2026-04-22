/**
 * Workflow component for multi-step orchestration.
 *
 * Phase 1: In-memory orchestration with basic coordination
 * Phase 2: Durable execution with checkpoint/replay and distributed tasks
 */

import type { Context, WorkflowHandler } from './types.js';
import { ContextImpl } from './context.js';

/**
 * Workflow configuration
 */
export interface WorkflowConfig {
  name: string;
  handler: WorkflowHandler;
  /** Cron expression for scheduled execution (e.g., "0 0/6 * * *") */
  cron?: string;
}

/**
 * Global workflow registry
 */
export class WorkflowRegistry {
  private static workflows = new Map<string, WorkflowConfig>();

  /**
   * Register a workflow handler
   */
  static register(config: WorkflowConfig): void {
    if (this.workflows.has(config.name)) {
      console.warn(`Overwriting existing workflow '${config.name}'`);
    }
    this.workflows.set(config.name, config);
  }

  /**
   * Get workflow configuration by name
   */
  static get(name: string): WorkflowConfig | undefined {
    return this.workflows.get(name);
  }

  /**
   * Get all registered workflows
   */
  static all(): Map<string, WorkflowConfig> {
    return new Map(this.workflows);
  }

  /**
   * List all registered workflow names
   */
  static listNames(): string[] {
    return Array.from(this.workflows.keys());
  }

  /**
   * Clear all registered workflows (for testing)
   */
  static clear(): void {
    this.workflows.clear();
  }
}

/**
 * Workflow options
 */
export interface WorkflowOptions {
  /** Custom workflow name (defaults to function name) */
  name?: string;
  /** Cron expression for scheduled execution (e.g., "0 0/6 * * *") */
  cron?: string;
}

/**
 * Decorator to mark a function as a durable workflow
 *
 * @example
 * ```typescript
 * const processOrder = workflow('process-order', async (ctx: Context, orderId: string) => {
 *   // Validate order
 *   const order = await ctx.step('validate', async () => {
 *     return { id: orderId, total: 100 };
 *   });
 *
 *   // Process payment
 *   const payment = await ctx.step('payment', async () => {
 *     return { status: 'success' };
 *   });
 *
 *   // Fulfill order
 *   await ctx.step('fulfill', async () => {
 *     console.log('Order fulfilled');
 *   });
 *
 *   return { status: 'completed' };
 * });
 * ```
 */
export function workflow<TInput = any, TOutput = any>(
  nameOrHandler: string | WorkflowHandler<TInput, TOutput>,
  handlerOrOptions?: WorkflowHandler<TInput, TOutput> | WorkflowOptions,
  optionsParam?: WorkflowOptions
): WorkflowHandler<TInput, TOutput> {
  let workflowName: string;
  let handler: WorkflowHandler<TInput, TOutput>;
  let options: WorkflowOptions = {};

  // Parse arguments
  if (typeof nameOrHandler === 'string') {
    workflowName = nameOrHandler;
    if (typeof handlerOrOptions === 'function') {
      handler = handlerOrOptions as WorkflowHandler<TInput, TOutput>;
      options = optionsParam || {};
    } else {
      throw new Error('Invalid workflow definition: handler must be a function');
    }
  } else if (typeof nameOrHandler === 'function') {
    handler = nameOrHandler as WorkflowHandler<TInput, TOutput>;
    workflowName = (handler as any).name || 'anonymous-workflow';
    options = (handlerOrOptions as WorkflowOptions) || {};
  } else {
    throw new Error('Invalid workflow definition');
  }

  // Override name if provided in options
  if (options.name) {
    workflowName = options.name;
  }

  // Register workflow
  const config: WorkflowConfig = {
    name: workflowName,
    handler,
    cron: options.cron,
  };
  WorkflowRegistry.register(config);

  // Create wrapper that provides context
  const workflowWrapper = async (ctxOrInput: Context | TInput, input?: TInput): Promise<TOutput> => {
    let ctx: Context;
    let actualInput: TInput;

    // Determine if first arg is Context or input
    if (isContext(ctxOrInput)) {
      ctx = ctxOrInput;
      actualInput = input!;
    } else {
      // Auto-create context for direct workflow calls
      ctx = new ContextImpl(
        `workflow-${workflowName}-${Date.now()}`,
        `run-${Date.now()}`,
        0,
        workflowName
      );
      actualInput = ctxOrInput as TInput;
    }

    // Execute workflow
    return handler(ctx, actualInput);
  };

  // Attach config for introspection
  (workflowWrapper as any)._agnt5_config = config;

  return workflowWrapper as WorkflowHandler<TInput, TOutput>;
}

/**
 * Type guard to check if value is a Context
 */
function isContext(value: any): value is Context {
  return (
    value &&
    typeof value === 'object' &&
    'invocationId' in value &&
    'runId' in value &&
    'step' in value &&
    'logger' in value
  );
}
