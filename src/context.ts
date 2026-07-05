import type { Context, Logger } from './types.js';
import type { EventEmitter } from './event-emitter.js';
import { emptyRuntimeContext } from './runtime-context.js';
import type { RuntimeContext } from './runtime-context.js';
import { ConfigurationError, SuspensionRequestedError, WaitingForUserInputError } from './errors.js';
import type { HITLInputType, HITLOption } from './errors.js';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Lazy-loaded native log function for OTLP export
let _nativeLogFn: ((level: string, message: string, runId: string | null, traceId: string | null, spanId: string | null, attributes: Record<string, string> | null) => void) | null | undefined;

function getNativeLogFn() {
  if (_nativeLogFn !== undefined) return _nativeLogFn;
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const require = createRequire(import.meta.url);
    const paths = [
      join(__dirname, '../../native/agnt5-sdk-native.darwin-arm64.node'),
      join(__dirname, '../native/agnt5-sdk-native.darwin-arm64.node'),
      join(__dirname, '../../native/agnt5-sdk-native.linux-x64-gnu.node'),
      join(__dirname, '../native/agnt5-sdk-native.linux-x64-gnu.node'),
    ];
    for (const p of paths) {
      try {
        const native = require(p);
        if (native.logFromTypescript) {
          _nativeLogFn = native.logFromTypescript;
          return _nativeLogFn;
        }
      } catch { continue; }
    }
  } catch { /* native not available */ }
  _nativeLogFn = null;
  return null;
}

/**
 * Storage backend interface
 */
interface StorageBackend {
  get(key: string): Promise<any | undefined>;
  set(key: string, value: any): Promise<void>;
  delete(key: string): Promise<boolean>;
  getCheckpoint(key: string): Promise<any | undefined>;
  setCheckpoint(key: string, value: any): Promise<void>;
}

/**
 * SQLite storage backend for durable state
 */
class SQLiteStorage implements StorageBackend {
  private db: any;

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = join(dbPath, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Initialize SQLite database
    const Database = loadBetterSqlite3();
    this.db = new Database(dbPath);

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  async get(key: string): Promise<any | undefined> {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.value);
  }

  async set(key: string, value: any): Promise<void> {
    const json = JSON.stringify(value);
    this.db.prepare(`
      INSERT INTO state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(key, json, Date.now());
  }

  async delete(key: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM state WHERE key = ?').run(key);
    return result.changes > 0;
  }

  async getCheckpoint(key: string): Promise<any | undefined> {
    const row = this.db.prepare('SELECT value FROM checkpoints WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.value);
  }

  async setCheckpoint(key: string, value: any): Promise<void> {
    const json = JSON.stringify(value);
    this.db.prepare(`
      INSERT INTO checkpoints (key, value, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value
    `).run(key, json, Date.now());
  }

  close(): void {
    this.db.close();
  }
}

function loadBetterSqlite3(): new (dbPath: string) => any {
  try {
    const require = createRequire(import.meta.url);
    const loaded = require('better-sqlite3');
    return (loaded.default ?? loaded) as new (dbPath: string) => any;
  } catch (err) {
    throw new ConfigurationError(
      `SQLite storage requires the optional "better-sqlite3" dependency. ` +
      `Install it or set AGNT5_STORAGE=memory. ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function validateSleepDuration(durationMs: number): void {
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
    throw new Error('sleep durationMs must be a non-negative safe integer');
  }
}

/**
 * In-memory storage backend for testing
 */
class MemoryStorage implements StorageBackend {
  private state = new Map<string, any>();
  private checkpoints = new Map<string, any>();

  constructor(checkpoints?: Record<string, any>) {
    for (const [key, value] of Object.entries(checkpoints || {})) {
      this.checkpoints.set(key, value);
    }
  }

  async get(key: string): Promise<any | undefined> {
    return this.state.get(key);
  }

  async set(key: string, value: any): Promise<void> {
    this.state.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.state.delete(key);
  }

  async getCheckpoint(key: string): Promise<any | undefined> {
    return this.checkpoints.get(key);
  }

  async setCheckpoint(key: string, value: any): Promise<void> {
    this.checkpoints.set(key, value);
  }
}

/**
 * Context implementation with durable storage
 */
export class ContextImpl implements Context {
  private storage: StorageBackend;
  private _pauseIndex = 0;
  private _emitter?: EventEmitter;
  private _checkpointSnapshot = new Map<string, any>();
  private _workerlessDeadlineMs?: number;
  private _workerlessYieldBeforeMs: number;
  /** Cancellation signal (never aborted on this context path). */
  readonly signal: AbortSignal = new AbortController().signal;

  constructor(
    public readonly invocationId: string,
    public readonly runId: string,
    public readonly attempt: number,
    public readonly serviceName: string,
    options?: {
      storage?: 'memory' | 'sqlite';
      dbPath?: string;
      runtime?: RuntimeContext;
      metadata?: Record<string, string>;
      checkpoints?: Record<string, any>;
      workerlessDeadlineMs?: number;
      workerlessYieldBeforeMs?: number;
    }
  ) {
    this.runtime = options?.runtime ?? emptyRuntimeContext();
    this.metadata = options?.metadata;
    this._checkpointSnapshot = new Map(Object.entries(options?.checkpoints || {}));
    this._workerlessDeadlineMs = options?.workerlessDeadlineMs;
    this._workerlessYieldBeforeMs = options?.workerlessYieldBeforeMs ?? 1000;
    const storageType = options?.storage || (process.env.AGNT5_STORAGE === 'sqlite' ? 'sqlite' : 'memory');

    if (storageType === 'sqlite') {
      const dbPath = options?.dbPath || process.env.AGNT5_DB_PATH || join(process.cwd(), '.agnt5', 'state.db');
      this.storage = new SQLiteStorage(dbPath);
    } else {
      this.storage = new MemoryStorage(options?.checkpoints);
    }
  }

  readonly runtime: RuntimeContext;
  readonly metadata?: Record<string, string>;

  async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
    const value = await this.storage.get(key);
    return value !== undefined ? value : defaultValue;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.storage.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return await this.storage.delete(key);
  }

  async step<T>(stepName: string, fn: () => T | Promise<T>): Promise<T> {
    const checkpointKey = `step:${stepName}`;

    // Check if step already executed (checkpoint exists)
    const existingCheckpoint = await this.storage.getCheckpoint(checkpointKey);
    if (existingCheckpoint !== undefined) {
      return existingCheckpoint;
    }

    // Execute step
    const result = await fn();

    // Checkpoint result
    await this.storage.setCheckpoint(checkpointKey, result);
    this._checkpointSnapshot.set(checkpointKey, result);

    return result;
  }

  async yieldIfNeeded(reason = 'budget'): Promise<void> {
    if (!this._workerlessDeadlineMs) {
      return;
    }
    if (Date.now() + this._workerlessYieldBeforeMs < this._workerlessDeadlineMs) {
      return;
    }
    throw new SuspensionRequestedError({
      runId: this.runId,
      reason,
      checkpointState: this.checkpointSnapshot(),
      deadlineMs: this._workerlessDeadlineMs,
    });
  }

  async sleep(durationMs: number, _name?: string): Promise<void> {
    validateSleepDuration(durationMs);
    if (durationMs === 0) {
      return;
    }
    await new Promise<void>(resolve => setTimeout(resolve, durationMs));
  }

  checkpointSnapshot(): Record<string, any> {
    return Object.fromEntries(this._checkpointSnapshot.entries());
  }

  get logger(): Logger {
    const runId = this.runId;
    const logFn = getNativeLogFn();
    return {
      info: (message: string, meta?: Record<string, any>) => {
        console.log(`[INFO] ${message}`, meta || '');
        logFn?.('INFO', message, runId, null, null, meta as Record<string, string> ?? null);
      },
      error: (message: string, meta?: Record<string, any>) => {
        console.error(`[ERROR] ${message}`, meta || '');
        logFn?.('ERROR', message, runId, null, null, meta as Record<string, string> ?? null);
      },
      warn: (message: string, meta?: Record<string, any>) => {
        console.warn(`[WARN] ${message}`, meta || '');
        logFn?.('WARN', message, runId, null, null, meta as Record<string, string> ?? null);
      },
      debug: (message: string, meta?: Record<string, any>) => {
        console.debug(`[DEBUG] ${message}`, meta || '');
        logFn?.('DEBUG', message, runId, null, null, meta as Record<string, string> ?? null);
      },
    };
  }

  async waitForUser(
    question: string,
    options?: {
      inputType?: HITLInputType;
      options?: HITLOption[];
      allowCustom?: boolean;
      skippable?: boolean;
    },
  ): Promise<string | null> {
    const pauseIndex = this._pauseIndex++;
    const responseKey = `user_response:${this.runId}:${pauseIndex}`;
    const stepName = `wait_for_user_${pauseIndex}`;

    // Check for cached response (resume path)
    const cached = await this.storage.getCheckpoint(responseKey);
    if (cached !== undefined) {
      return cached;
    }

    // First call — throw to pause execution
    throw new WaitingForUserInputError({
      runId: this.runId,
      question,
      inputType: options?.inputType,
      options: options?.options,
      pauseIndex,
      allowCustom: options?.allowCustom,
      skippable: options?.skippable,
      stepName,
    });
  }

  /**
   * Store a user response for HITL resume (called by platform on user reply).
   */
  async setUserResponse(pauseIndex: number, response: string | null): Promise<void> {
    const responseKey = `user_response:${this.runId}:${pauseIndex}`;
    await this.storage.setCheckpoint(responseKey, response);
  }

  async waitForSignal<T = unknown>(_signalName: string, _name?: string): Promise<T> {
    throw new ConfigurationError('ctx.waitForSignal is only supported by managed worker runtimes');
  }

  /**
   * Set the EventEmitter for platform event emission.
   */
  setEmitter(emitter: EventEmitter): void {
    this._emitter = emitter;
  }

  /**
   * Emit an event to the platform. No-op if no emitter is set (local/test mode).
   */
  async emit(event: any): Promise<void> {
    if (this._emitter) {
      await this._emitter.emit(event);
    }
  }

  /**
   * Close the storage backend (important for SQLite)
   */
  close(): void {
    if (this.storage instanceof SQLiteStorage) {
      this.storage.close();
    }
  }
}
