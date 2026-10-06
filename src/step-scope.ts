import { AsyncLocalStorage } from 'node:async_hooks';
import { ConfigurationError } from './errors.js';
import { currentActivation } from './activation.js';
const steps = new AsyncLocalStorage<boolean>();
export const inWorkflowStep = (): boolean => steps.getStore() === true;
export const runInWorkflowStep = <T>(execute: () => T): T => steps.run(true, execute);

/** A pause must not abandon an admitted step containing uncheckpointed effects. */
const openStreams = new WeakMap<object, number>();

export function trackWorkflowStream(ctx: object): () => void {
  openStreams.set(ctx, (openStreams.get(ctx) ?? 0) + 1);
  return () => { openStreams.set(ctx, (openStreams.get(ctx) ?? 1) - 1); };
}

export function assertWorkflowStreamsClosed(ctx: object): void {
  if (openStreams.get(ctx)) throw new ConfigurationError('Finish or close streaming function iterators before a workflow waits or completes');
}

export function assertWorkflowWaitBoundary(ctx?: object): void {
  if (ctx) assertWorkflowStreamsClosed(ctx);
  if (inWorkflowStep() || currentActivation()) throw new ConfigurationError('Managed waits must be called between workflow steps and outside active activations');
}
