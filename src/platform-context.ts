/**
 * Platform-backed Context implementation using native State and Span bindings
 * Phase 2: Durable state and distributed tracing
 */

import type { Context, Logger } from './types.js';
import { StateError, CheckpointError } from './errors.js';
import { loadNativeBindings, tryLoadNativeBindings } from './native-loader.js';
import { emptyRuntimeContext } from './runtime-context.js';
import type { RuntimeContext } from './runtime-context.js';

/**
 * Platform-backed context with durable state and distributed tracing
 */
export class PlatformContext implements Context {
  private stateManager: any; // StateManager from native bindings
  private span: any; // Span from native bindings
  private checkpointCounter = 0;
  /** Cancellation signal (never aborted on this adapter path). */
  readonly signal: AbortSignal = new AbortController().signal;
  readonly runtime: RuntimeContext = emptyRuntimeContext();

  constructor(
    public readonly invocationId: string,
    public readonly runId: string,
    public readonly attempt: number,
    public readonly serviceName: string,
    spanName?: string
  ) {
    const native = loadNativeBindings();
    this.stateManager = new native.StateManager();
    this.span = native.Span.create(spanName || `${serviceName}.${invocationId}`);

    // Set initial span attributes
    this.span.setAttribute('invocation.id', invocationId);
    this.span.setAttribute('run.id', runId);
    this.span.setAttribute('service.name', serviceName);
    this.span.setAttribute('attempt', String(attempt));
  }

  /**
   * Get value from state (async)
   */
  async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
    try {
      const buffer = await this.stateManager.get(key);
      if (!buffer) {
        return defaultValue;
      }
      const json = buffer.toString('utf-8');
      return JSON.parse(json) as T;
    } catch (error) {
      throw new StateError(
        `Failed to get state key '${key}': ${(error as Error).message}`,
        'get',
        key
      );
    }
  }

  /**
   * Set value in state (async)
   */
  async set<T>(key: string, value: T): Promise<void> {
    try {
      const json = JSON.stringify(value);
      const buffer = Buffer.from(json, 'utf-8');
      await this.stateManager.set(key, buffer);

      // Record in span
      this.span.addEvent('state.set', { key });
    } catch (error) {
      this.span.recordError(`State set failed: ${(error as Error).message}`);
      throw new StateError(
        `Failed to set state key '${key}': ${(error as Error).message}`,
        'set',
        key
      );
    }
  }

  /**
   * Delete value from state (async)
   */
  async delete(key: string): Promise<boolean> {
    try {
      const deleted = await this.stateManager.delete(key);

      // Record in span
      this.span.addEvent('state.delete', { key, deleted: String(deleted) });

      return deleted;
    } catch (error) {
      this.span.recordError(`State delete failed: ${(error as Error).message}`);
      throw new StateError(
        `Failed to delete state key '${key}': ${(error as Error).message}`,
        'delete',
        key
      );
    }
  }

  /**
   * Execute a step with checkpointing
   */
  async step<T>(stepName: string, fn: () => T | Promise<T>): Promise<T> {
    const checkpointKey = `checkpoint:${stepName}`;

    try {
      // Check if step already executed (checkpoint exists)
      const existingCheckpoint = await this.stateManager.get(checkpointKey);
      if (existingCheckpoint) {
        this.span.addEvent('step.restored', { step: stepName });
        const json = existingCheckpoint.toString('utf-8');
        return JSON.parse(json) as T;
      }

      // Start step span
      this.span.addEvent('step.started', { step: stepName });

      // Execute step
      const result = await fn();

      // Checkpoint result
      const json = JSON.stringify(result);
      const buffer = Buffer.from(json, 'utf-8');
      await this.stateManager.set(checkpointKey, buffer);

      this.checkpointCounter++;
      this.span.addEvent('step.completed', {
        step: stepName,
        sequence: String(this.checkpointCounter),
      });

      return result;
    } catch (error) {
      this.span.recordError(`Step '${stepName}' failed: ${(error as Error).message}`);
      throw new CheckpointError(
        `Failed to execute step '${stepName}': ${(error as Error).message}`,
        stepName,
        this.checkpointCounter
      );
    }
  }

  /**
   * Get logger with span integration
   */
  get logger(): Logger {
    const runId = this.runId;
    const native = tryLoadNativeBindings();
    return {
      info: (message: string, meta?: Record<string, any>) => {
        console.log(`[INFO] ${message}`, meta || '');
        this.span.addEvent('log.info', { message, ...meta });
        native?.logFromTypescript('INFO', message, runId, null, null, meta ?? null);
      },
      error: (message: string, meta?: Record<string, any>) => {
        console.error(`[ERROR] ${message}`, meta || '');
        this.span.addEvent('log.error', { message, ...meta });
        this.span.recordError(message);
        native?.logFromTypescript('ERROR', message, runId, null, null, meta ?? null);
      },
      warn: (message: string, meta?: Record<string, any>) => {
        console.warn(`[WARN] ${message}`, meta || '');
        this.span.addEvent('log.warn', { message, ...meta });
        native?.logFromTypescript('WARN', message, runId, null, null, meta ?? null);
      },
      debug: (message: string, meta?: Record<string, any>) => {
        console.debug(`[DEBUG] ${message}`, meta || '');
        this.span.addEvent('log.debug', { message, ...meta });
        native?.logFromTypescript('DEBUG', message, runId, null, null, meta ?? null);
      },
    };
  }

  /**
   * Get the underlying span for advanced use cases
   */
  getSpan(): any {
    return this.span;
  }

  /**
   * Get the underlying state manager for advanced use cases
   */
  getStateManager(): any {
    return this.stateManager;
  }

  /**
   * Emit an event to the platform. No-op in PlatformContext (events are handled by the worker).
   */
  async emit(event: any): Promise<void> {
    // PlatformContext doesn't emit events directly — the worker's EventEmitter handles this.
  }

  /**
   * End the span (call this when context is no longer needed)
   */
  endSpan(): void {
    if (this.span && !this.span.isEnded()) {
      this.span.end();
    }
  }
}
