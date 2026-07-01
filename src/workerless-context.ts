import { SuspensionRequestedError } from './errors.js';
import { emptyRuntimeContext } from './runtime-context.js';
import type { RuntimeContext } from './runtime-context.js';
import type { Context, Logger } from './types.js';

export interface WorkerlessContextOptions {
  checkpoints?: Record<string, unknown>;
  runtime?: RuntimeContext;
  workerlessDeadlineMs?: number;
  workerlessYieldBeforeMs?: number;
}

export class WorkerlessContext implements Context {
  private readonly state = new Map<string, unknown>();
  private readonly checkpoints = new Map<string, unknown>();
  private readonly workerlessDeadlineMs?: number;
  private readonly workerlessYieldBeforeMs: number;
  readonly runtime: RuntimeContext;
  readonly signal: AbortSignal = new AbortController().signal;

  constructor(
    public readonly invocationId: string,
    public readonly runId: string,
    public readonly attempt: number,
    public readonly serviceName: string,
    options: WorkerlessContextOptions = {},
  ) {
    this.runtime = options.runtime ?? emptyRuntimeContext();
    this.workerlessDeadlineMs = options.workerlessDeadlineMs;
    this.workerlessYieldBeforeMs = options.workerlessYieldBeforeMs ?? 1000;
    for (const [key, value] of Object.entries(options.checkpoints || {})) {
      this.checkpoints.set(key, value);
    }
  }

  async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
    const value = this.state.get(key);
    return value !== undefined ? value as T : defaultValue;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.state.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.state.delete(key);
  }

  async step<T>(stepName: string, fn: () => T | Promise<T>): Promise<T> {
    const checkpointKey = `step:${stepName}`;
    const existingCheckpoint = this.checkpoints.get(checkpointKey);
    if (existingCheckpoint !== undefined) {
      return existingCheckpoint as T;
    }

    const result = await fn();
    this.checkpoints.set(checkpointKey, result);
    return result;
  }

  async yieldIfNeeded(reason = 'budget'): Promise<void> {
    if (!this.workerlessDeadlineMs) {
      return;
    }
    if (Date.now() + this.workerlessYieldBeforeMs < this.workerlessDeadlineMs) {
      return;
    }
    throw new SuspensionRequestedError({
      runId: this.runId,
      reason,
      checkpointState: this.checkpointSnapshot(),
      deadlineMs: this.workerlessDeadlineMs,
    });
  }

  checkpointSnapshot(): Record<string, unknown> {
    return Object.fromEntries(this.checkpoints.entries());
  }

  get logger(): Logger {
    return {
      info: (message: string, meta?: Record<string, unknown>) => console.log(`[INFO] ${message}`, meta || ''),
      error: (message: string, meta?: Record<string, unknown>) => console.error(`[ERROR] ${message}`, meta || ''),
      warn: (message: string, meta?: Record<string, unknown>) => console.warn(`[WARN] ${message}`, meta || ''),
      debug: (message: string, meta?: Record<string, unknown>) => console.debug(`[DEBUG] ${message}`, meta || ''),
    };
  }

  async emit(_event: unknown): Promise<void> {
    return undefined;
  }

  close(): void {
    // No resources to release for workerless in-memory execution.
  }
}
