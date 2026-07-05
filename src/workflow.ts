/**
 * Workflow component for multi-step orchestration.
 *
 * Phase 1: In-memory orchestration with basic coordination
 * Phase 2: Durable execution with checkpoint/replay and distributed tasks
 */

import type { Context, WorkflowHandler } from './types.js';
import {
  event,
  webhook,
  WorkflowRegistry,
} from './workflow-registry.js';
import type {
  EventTriggerOptions,
  TriggerSpec,
  WebhookTriggerOptions,
  WorkflowConfig,
  WorkflowOptions,
} from './workflow-registry.js';

export {
  event,
  webhook,
  WorkflowRegistry,
};
export type {
  EventTriggerOptions,
  TriggerSpec,
  WebhookTriggerOptions,
  WorkflowConfig,
  WorkflowOptions,
};

/**
 * Decorator to mark a function as a durable workflow
 *
 * @example
 * ```typescript
 * const processOrder = workflow('process-order', async (ctx: Context, orderId: string) => {
 *   const order = await ctx.step('validate', async () => ({ id: orderId, total: 100 }));
 *   return { status: 'completed', order };
 * });
 * ```
 */
export function workflow<TInput = any, TOutput = any>(
  nameOrHandler: string | WorkflowHandler<TInput, TOutput>,
  handlerOrOptions?: WorkflowHandler<TInput, TOutput> | WorkflowOptions,
  optionsParam?: WorkflowOptions,
): WorkflowHandler<TInput, TOutput> {
  let workflowName: string;
  let handler: WorkflowHandler<TInput, TOutput>;
  let options: WorkflowOptions = {};

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

  if (options.name) {
    workflowName = options.name;
  }

  const config: WorkflowConfig = {
    name: workflowName,
    handler,
    cron: options.cron,
    triggers: options.triggers,
    flowControl: options.flowControl,
    flow_control: options.flow_control,
    priority: options.priority,
    maxConcurrency: options.maxConcurrency,
  };
  WorkflowRegistry.register(config);

  const workflowWrapper = async (ctxOrInput: Context | TInput, input?: TInput): Promise<TOutput> => {
    let ctx: Context;
    let actualInput: TInput;

    if (isContext(ctxOrInput)) {
      ctx = ctxOrInput;
      actualInput = input!;
    } else {
      const { ContextImpl } = await import('./context.js');
      ctx = new ContextImpl(
        `workflow-${workflowName}-${Date.now()}`,
        `run-${Date.now()}`,
        0,
        workflowName,
      );
      actualInput = ctxOrInput as TInput;
    }

    return handler(ctx, actualInput);
  };

  (workflowWrapper as any)._agnt5_config = config;

  return workflowWrapper as WorkflowHandler<TInput, TOutput>;
}

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
