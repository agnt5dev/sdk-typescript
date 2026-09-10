import { AsyncLocalStorage } from 'node:async_hooks';

// Reader ancestry is separate from durable activation ownership and identity.
// Agent iterations are journal events, not admitted durable activations.
const displayParentStorage = new AsyncLocalStorage<string | undefined>();

export function currentDisplayParentCorrelationId(): string | undefined {
  return displayParentStorage.getStore();
}

export function runWithDisplayParent<T>(
  correlationId: string | undefined,
  execute: () => T,
): T {
  return displayParentStorage.run(correlationId, execute);
}
