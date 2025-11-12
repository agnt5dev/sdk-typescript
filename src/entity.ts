/**
 * Entity component for stateful operations with single-writer consistency.
 *
 * Production ready with durable state and locks via SQLite or platform
 */

import type { Context, EntityMethod, Logger } from './types.js';
import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

/**
 * Entity storage backend interface
 */
interface EntityStorageBackend {
  get(entityKey: string, stateKey: string): Promise<any | undefined>;
  set(entityKey: string, stateKey: string, value: any): Promise<void>;
  delete(entityKey: string, stateKey: string): Promise<boolean>;
  getAll(entityKey: string): Promise<Map<string, any>>;
  acquireLock(entityKey: string): Promise<void>;
  releaseLock(entityKey: string): Promise<void>;
}

/**
 * SQLite-backed entity storage
 */
class SQLiteEntityStorage implements EntityStorageBackend {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = join(dbPath, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Initialize SQLite database
    this.db = new Database(dbPath);

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entity_state (
        entity_key TEXT NOT NULL,
        state_key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (entity_key, state_key)
      );

      CREATE INDEX IF NOT EXISTS idx_entity_key ON entity_state(entity_key);

      CREATE TABLE IF NOT EXISTS entity_locks (
        entity_key TEXT PRIMARY KEY,
        locked_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  async get(entityKey: string, stateKey: string): Promise<any | undefined> {
    const row = this.db.prepare(
      'SELECT value FROM entity_state WHERE entity_key = ? AND state_key = ?'
    ).get(entityKey, stateKey) as { value: string } | undefined;

    if (!row) return undefined;
    return JSON.parse(row.value);
  }

  async set(entityKey: string, stateKey: string, value: any): Promise<void> {
    const json = JSON.stringify(value);
    this.db.prepare(`
      INSERT INTO entity_state (entity_key, state_key, value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(entity_key, state_key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(entityKey, stateKey, json, Date.now());
  }

  async delete(entityKey: string, stateKey: string): Promise<boolean> {
    const result = this.db.prepare(
      'DELETE FROM entity_state WHERE entity_key = ? AND state_key = ?'
    ).run(entityKey, stateKey);
    return result.changes > 0;
  }

  async getAll(entityKey: string): Promise<Map<string, any>> {
    const rows = this.db.prepare(
      'SELECT state_key, value FROM entity_state WHERE entity_key = ?'
    ).all(entityKey) as Array<{ state_key: string; value: string }>;

    const map = new Map<string, any>();
    for (const row of rows) {
      map.set(row.state_key, JSON.parse(row.value));
    }
    return map;
  }

  async acquireLock(entityKey: string): Promise<void> {
    // Simple lock with expiration (30 seconds)
    const now = Date.now();
    const expiresAt = now + 30000;

    // Clean up expired locks
    this.db.prepare('DELETE FROM entity_locks WHERE expires_at < ?').run(now);

    // Try to acquire lock
    let attempts = 0;
    const maxAttempts = 100;
    while (attempts < maxAttempts) {
      try {
        this.db.prepare(`
          INSERT INTO entity_locks (entity_key, locked_at, expires_at)
          VALUES (?, ?, ?)
        `).run(entityKey, now, expiresAt);
        return; // Lock acquired
      } catch (error) {
        // Lock exists, wait and retry
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }
    }

    throw new Error(`Failed to acquire lock for entity ${entityKey} after ${maxAttempts} attempts`);
  }

  async releaseLock(entityKey: string): Promise<void> {
    this.db.prepare('DELETE FROM entity_locks WHERE entity_key = ?').run(entityKey);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * In-memory entity storage (for testing)
 */
class MemoryEntityStorage implements EntityStorageBackend {
  private state = new Map<string, Map<string, any>>();
  private locks = new Map<string, Promise<void>>();
  private releasers = new Map<string, () => void>();

  async get(entityKey: string, stateKey: string): Promise<any | undefined> {
    return this.state.get(entityKey)?.get(stateKey);
  }

  async set(entityKey: string, stateKey: string, value: any): Promise<void> {
    if (!this.state.has(entityKey)) {
      this.state.set(entityKey, new Map());
    }
    this.state.get(entityKey)!.set(stateKey, value);
  }

  async delete(entityKey: string, stateKey: string): Promise<boolean> {
    const entityState = this.state.get(entityKey);
    if (!entityState) return false;
    return entityState.delete(stateKey);
  }

  async getAll(entityKey: string): Promise<Map<string, any>> {
    return this.state.get(entityKey) || new Map();
  }

  async acquireLock(entityKey: string): Promise<void> {
    // Wait for any existing lock
    while (this.locks.has(entityKey)) {
      await this.locks.get(entityKey);
    }

    // Create new lock
    let releaser: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaser = resolve;
    });

    this.locks.set(entityKey, lockPromise);
    this.releasers.set(entityKey, releaser!);
  }

  async releaseLock(entityKey: string): Promise<void> {
    const releaser = this.releasers.get(entityKey);
    if (releaser) {
      releaser();
      this.locks.delete(entityKey);
      this.releasers.delete(entityKey);
    }
  }
}

// Global storage backend
let globalStorage: EntityStorageBackend | null = null;

function getGlobalStorage(): EntityStorageBackend {
  if (!globalStorage) {
    const storageType = process.env.AGNT5_STORAGE === 'memory' ? 'memory' : 'sqlite';
    if (storageType === 'sqlite') {
      const dbPath = process.env.AGNT5_DB_PATH || join(process.cwd(), '.agnt5', 'entities.db');
      globalStorage = new SQLiteEntityStorage(dbPath);
    } else {
      globalStorage = new MemoryEntityStorage();
    }
  }
  return globalStorage;
}

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

    const storage = getGlobalStorage();

    // Acquire lock for single-writer guarantee
    await storage.acquireLock(this.stateKey);

    try {
      // Create Context with entity state
      const ctx = new EntityContext(
        this.entityType.name,
        this.key,
        methodName,
        this.stateKey,
        storage
      );

      // Execute method
      const result = await method(ctx, ...args);

      return result as TOutput;
    } finally {
      // Release lock
      await storage.releaseLock(this.stateKey);
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
 * Provides access to entity-specific state with durable storage
 */
class EntityContext implements Context {
  private storage: EntityStorageBackend;
  private entityKey: string;
  private checkpointCache: Map<string, any> = new Map();

  readonly invocationId: string;
  readonly runId: string;
  readonly attempt: number = 0;
  readonly serviceName: string;

  constructor(
    entityType: string,
    key: string,
    methodName: string,
    entityKey: string,
    storage: EntityStorageBackend
  ) {
    this.storage = storage;
    this.entityKey = entityKey;
    this.runId = `${entityType}:${key}:${methodName}`;
    this.invocationId = this.runId;
    this.serviceName = entityType;
  }

  async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
    const value = await this.storage.get(this.entityKey, key);
    return value !== undefined ? value : defaultValue;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.storage.set(this.entityKey, key, value);
  }

  async delete(key: string): Promise<boolean> {
    return await this.storage.delete(this.entityKey, key);
  }

  async step<T>(stepName: string, fn: () => T | Promise<T>): Promise<T> {
    const checkpointKey = `checkpoint:${stepName}`;

    // Check cache first
    if (this.checkpointCache.has(stepName)) {
      return this.checkpointCache.get(stepName);
    }

    // Check persistent storage
    const existing = await this.storage.get(this.entityKey, checkpointKey);
    if (existing !== undefined) {
      this.checkpointCache.set(stepName, existing);
      return existing;
    }

    // Execute step
    const result = await fn();

    // Save checkpoint
    await this.storage.set(this.entityKey, checkpointKey, result);
    this.checkpointCache.set(stepName, result);

    return result;
  }

  get logger(): Logger {
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
 * Clear all entity state and locks (only works for in-memory storage)
 * @internal
 */
export function _clearEntityState(): void {
  if (globalStorage instanceof MemoryEntityStorage) {
    globalStorage = null; // Force recreation
  } else {
    console.warn('_clearEntityState only works with in-memory storage');
  }
}

/**
 * Get current state of an entity instance
 * @internal
 */
export async function _getEntityState(entityType: string, key: string): Promise<Map<string, any> | undefined> {
  const stateKey = `${entityType}:${key}`;
  const storage = getGlobalStorage();
  return await storage.getAll(stateKey);
}

/**
 * Set storage backend for testing
 * @internal
 */
export function _setEntityStorage(storage: EntityStorageBackend | null): void {
  globalStorage = storage;
}
