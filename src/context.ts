import type { Context, Logger } from './types.js';

/**
 * Simple in-memory context implementation
 * Phase 1: Local state only
 * Phase 2: Will integrate with platform for durable state
 */
export class ContextImpl implements Context {
  private state: Map<string, any> = new Map();
  private checkpoints: Map<string, any> = new Map();

  constructor(
    public readonly invocationId: string,
    public readonly runId: string,
    public readonly attempt: number,
    public readonly serviceName: string
  ) {}

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
    // Check if step already executed (checkpoint exists)
    if (this.checkpoints.has(stepName)) {
      return this.checkpoints.get(stepName);
    }

    // Execute step
    const result = await fn();

    // Checkpoint result
    this.checkpoints.set(stepName, result);

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
}
