/**
 * Entity component for stateful operations with single-writer consistency.
 *
 * Entities provide isolated state per unique key with automatic consistency guarantees.
 * Phase 1: In-memory state with local locks for single-writer semantics
 * Phase 2: Durable state with distributed locks via platform
 */

import type { Context, EntityMethod } from './types.js';

/**
 * Global storage for in-memory entity state and locks
 * Phase 2 will replace with platform-backed durable storage
 */
const entityStates = new Map<string, Map<string, any>>();
const entityLocks = new Map<string, Promise<void>>();
const lockReleasers = new Map<string, () => void>();

/**
 * Entity type definition with registered methods
 */
export class EntityType {
  readonly name: string;
  private methods: Map<string, EntityMethod> = new Map();

  constructor(name: string) {
    this.name = name;
  }

  /**
   * Register a method on this entity type
   *
   * @example
   * ```typescript
   * const Counter = entity('Counter');
   *
   * Counter.method('increment', async (ctx: Context, amount: number = 1) => {
   *   const current = ctx.get<number>('count', 0);
   *   const newCount = current + amount;
   *   ctx.set('count', newCount);
   *   return newCount;
   * });
   * ```
   */
  method<TInput = any, TOutput = any>(
    name: string,
    handler: EntityMethod<TInput, TOutput>
  ): void {
    if (this.methods.has(name)) {
      console.warn(`Overwriting existing method '${name}' on entity type '${this.name}'`);
    }
    this.methods.set(name, handler);
  }

  /**
   * Create an instance of this entity type with a specific key
   *
   * @example
   * ```typescript
   * const counter = Counter('user-123');
   * await counter.increment(5);
   * ```
   */
  call(key: string): EntityInstance {
    return new EntityInstance(this, key);
  }

  /**
   * Get a registered method by name
   * @internal
   */
  _getMethod(name: string): EntityMethod | undefined {
    return this.methods.get(name);
  }

  /**
   * List all registered method names
   */
  listMethods(): string[] {
    return Array.from(this.methods.keys());
  }
}

/**
 * Entity instance bound to a specific key
 */
export class EntityInstance {
  private entityType: EntityType;
  private key: string;
  private stateKey: string;

  constructor(entityType: EntityType, key: string) {
    this.entityType = entityType;
    this.key = key;
    this.stateKey = `${entityType.name}:${key}`;
  }

  /**
   * Invoke a method on this entity instance
   *
   * This provides single-writer consistency - only one operation
   * executes at a time per entity instance (per key).
   */
  async invoke<TOutput = any>(
    methodName: string,
    ...args: any[]
  ): Promise<TOutput> {
    const method = this.entityType._getMethod(methodName);
    if (!method) {
      throw new Error(
        `Entity type '${this.entityType.name}' has no method '${methodName}'. ` +
        `Available methods: ${this.entityType.listMethods().join(', ') || 'none'}`
      );
    }

    // Acquire lock for single-writer guarantee
    await this.acquireLock();

    try {
      // Get or create state for this entity instance
      if (!entityStates.has(this.stateKey)) {
        entityStates.set(this.stateKey, new Map());
      }
      const stateDict = entityStates.get(this.stateKey)!;

      // Create Context with entity state
      const ctx = new EntityContext(
        this.entityType.name,
        this.key,
        methodName,
        stateDict
      );

      // Execute method
      const result = await method(ctx, ...args);

      return result as TOutput;
    } finally {
      // Release lock
      this.releaseLock();
    }
  }

  /**
   * Acquire lock for this entity instance
   */
  private async acquireLock(): Promise<void> {
    // Wait for any existing lock to be released
    while (entityLocks.has(this.stateKey)) {
      await entityLocks.get(this.stateKey);
    }

    // Create new lock
    let releaseLock: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    entityLocks.set(this.stateKey, lockPromise);
    lockReleasers.set(this.stateKey, releaseLock!);
  }

  /**
   * Release lock for this entity instance
   */
  private releaseLock(): void {
    const releaser = lockReleasers.get(this.stateKey);
    if (releaser) {
      releaser();
      entityLocks.delete(this.stateKey);
      lockReleasers.delete(this.stateKey);
    }
  }

  /**
   * Get entity type name
   */
  getEntityType(): string {
    return this.entityType.name;
  }

  /**
   * Get entity instance key
   */
  getKey(): string {
    return this.key;
  }
}

/**
 * Context implementation for entity methods
 * Provides access to entity-specific state
 */
class EntityContext implements Context {
  private state: Map<string, any>;
  private checkpoints: Map<string, any> = new Map();

  readonly invocationId: string;
  readonly runId: string;
  readonly attempt: number = 0;
  readonly serviceName: string;

  constructor(
    entityType: string,
    key: string,
    methodName: string,
    stateDict: Map<string, any>
  ) {
    this.state = stateDict;
    this.runId = `${entityType}:${key}:${methodName}`;
    this.invocationId = this.runId;
    this.serviceName = entityType;
  }

  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.state.get(key) ?? defaultValue;
  }

  set<T>(key: string, value: T): void {
    this.state.set(key, value);
  }

  delete(key: string): void {
    this.state.delete(key);
  }

  async step<T>(stepName: string, fn: () => T | Promise<T>): Promise<T> {
    if (this.checkpoints.has(stepName)) {
      return this.checkpoints.get(stepName);
    }

    const result = await fn();
    this.checkpoints.set(stepName, result);
    return result;
  }

  get logger() {
    return {
      info: (message: string, meta?: Record<string, any>) => {
        console.log(`[INFO] ${message}`, meta || '');
      },
      error: (message: string, meta?: Record<string, any>) => {
        console.error(`[ERROR] ${message}`, meta || '');
      },
      warn: (message: string, meta?: Record<string, any>) => {
        console.warn(`[WARN] ${message}`, meta || '');
      },
      debug: (message: string, meta?: Record<string, any>) => {
        console.debug(`[DEBUG] ${message}`, meta || '');
      }
    };
  }
}

/**
 * Create a new entity type
 *
 * @example
 * ```typescript
 * const Counter = entity('Counter');
 *
 * Counter.method('increment', async (ctx: Context, amount: number = 1) => {
 *   const current = ctx.get<number>('count', 0);
 *   const newCount = current + amount;
 *   ctx.set('count', newCount);
 *   return newCount;
 * });
 *
 * Counter.method('getCount', async (ctx: Context) => {
 *   return ctx.get<number>('count', 0);
 * });
 *
 * // Create instances
 * const counter1 = Counter('user-123');
 * const counter2 = Counter('user-456');
 *
 * // Invoke methods (guaranteed single-writer per key)
 * const result = await counter1.invoke('increment', 5);
 * ```
 */
export function entity(name: string): EntityType {
  return new EntityType(name);
}

/**
 * Utility functions for testing and debugging
 */

/**
 * Clear all entity state and locks
 * @internal
 */
export function _clearEntityState(): void {
  entityStates.clear();
  entityLocks.clear();
  lockReleasers.clear();
}

/**
 * Get current state of an entity instance
 * @internal
 */
export function _getEntityState(entityType: string, key: string): Map<string, any> | undefined {
  const stateKey = `${entityType}:${key}`;
  return entityStates.get(stateKey);
}

/**
 * Get all keys for a given entity type
 * @internal
 */
export function _getAllEntityKeys(entityType: string): string[] {
  const keys: string[] = [];
  for (const stateKey of entityStates.keys()) {
    const [type, key] = stateKey.split(':', 2);
    if (type === entityType) {
      keys.push(key);
    }
  }
  return keys;
}
