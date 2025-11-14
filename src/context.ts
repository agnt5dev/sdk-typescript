import type { Context, Logger } from './types.js';
import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

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

/**
 * In-memory storage backend for testing
 */
class MemoryStorage implements StorageBackend {
  private state = new Map<string, any>();
  private checkpoints = new Map<string, any>();

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

  constructor(
    public readonly invocationId: string,
    public readonly runId: string,
    public readonly attempt: number,
    public readonly serviceName: string,
    options?: {
      storage?: 'memory' | 'sqlite';
      dbPath?: string;
    }
  ) {
    const storageType = options?.storage || (process.env.AGNT5_STORAGE === 'memory' ? 'memory' : 'sqlite');

    if (storageType === 'sqlite') {
      const dbPath = options?.dbPath || process.env.AGNT5_DB_PATH || join(process.cwd(), '.agnt5', 'state.db');
      this.storage = new SQLiteStorage(dbPath);
    } else {
      this.storage = new MemoryStorage();
    }
  }

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
      },
    };
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
