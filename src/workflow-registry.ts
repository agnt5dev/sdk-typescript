import type { WorkflowHandler } from './types.js';

export interface WorkflowConfig {
  name: string;
  handler: WorkflowHandler;
  /** Cron expression for scheduled execution (e.g., "0 0/6 * * *") */
  cron?: string;
  /** Typed trigger declarations attached to this workflow registration. */
  triggers?: TriggerSpec[];
}

export interface TriggerSpec {
  triggerId?: string;
  triggerType: 'event' | 'cron' | 'webhook';
  eventName?: string;
  filterExpression?: string;
  inputMapping?: string;
  batchWindowMs?: number;
  delayExpression?: string;
}

export interface EventTriggerOptions {
  triggerId?: string;
  filterExpression?: string;
  inputMapping?: string;
  batchWindowMs?: number;
  delayExpression?: string;
}

export interface WebhookTriggerOptions extends EventTriggerOptions {
  /** Event identifier within the source. The runtime dispatches on
   *  `{source}.{event}` (e.g. `sentry.issue.created`,
   *  `github.issues.opened`, `stripe.payment_intent.succeeded`,
   *  `slack.app_mention`). For Standard Webhooks publishers use the
   *  `webhook-event` header value. */
  event: string;
}

export interface WorkflowOptions {
  /** Custom workflow name (defaults to function name) */
  name?: string;
  /** Cron expression for scheduled execution (e.g., "0 0/6 * * *") */
  cron?: string;
  /** Typed trigger declarations such as event('user.created') */
  triggers?: TriggerSpec[];
}

export function event(name: string, options: EventTriggerOptions = {}): TriggerSpec {
  const eventName = name.trim();
  if (!eventName) {
    throw new Error('event trigger name is required');
  }
  return {
    triggerId: options.triggerId,
    triggerType: 'event',
    eventName,
    filterExpression: options.filterExpression,
    inputMapping: options.inputMapping,
    batchWindowMs: options.batchWindowMs,
    delayExpression: options.delayExpression,
  };
}

/**
 * Declare a webhook-event trigger for a workflow.
 *
 * Deliveries arriving at `POST /v1/webhooks/{source}/{integration_id}`
 * are dispatched as events with name `{source}.{event}`.
 */
export function webhook(source: string, options: WebhookTriggerOptions): TriggerSpec {
  const src = source.trim().toLowerCase();
  const evt = options.event?.trim();
  if (!src) {
    throw new Error('webhook source is required');
  }
  if (!evt) {
    throw new Error('webhook event is required');
  }
  return {
    triggerId: options.triggerId,
    triggerType: 'event',
    eventName: `${src}.${evt}`,
    filterExpression: options.filterExpression,
    inputMapping: options.inputMapping,
    batchWindowMs: options.batchWindowMs,
    delayExpression: options.delayExpression,
  };
}

export class WorkflowRegistry {
  private static workflows = new Map<string, WorkflowConfig>();

  static register(config: WorkflowConfig): void {
    if (this.workflows.has(config.name)) {
      console.warn(`Overwriting existing workflow '${config.name}'`);
    }
    this.workflows.set(config.name, config);
  }

  static get(name: string): WorkflowConfig | undefined {
    return this.workflows.get(name);
  }

  static all(): Map<string, WorkflowConfig> {
    return new Map(this.workflows);
  }

  static listNames(): string[] {
    return Array.from(this.workflows.keys());
  }

  static clear(): void {
    this.workflows.clear();
  }
}
