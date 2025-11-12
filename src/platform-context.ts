/**
 * Platform-backed Context implementation using native State and Span bindings
 * Phase 2: Durable state and distributed tracing
 */

import type { Context, Logger } from './types.js';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { StateError, CheckpointError } from './errors.js';

// Dynamic import for native bindings
let nativeBindings: any = null;

function loadNativeBindings() {
  if (nativeBindings) return nativeBindings;

  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const require = createRequire(import.meta.url);

    // Try multiple paths to find the native module
    const possiblePaths = [
      join(__dirname, '../../native/agnt5-sdk-native.linux-x64-gnu.node'),
      join(__dirname, '../native/agnt5-sdk-native.linux-x64-gnu.node'),
      join(__dirname, '../../native/agnt5-sdk-native.darwin-arm64.node'),
      join(__dirname, '../native/agnt5-sdk-native.darwin-arm64.node'),
    ];

    for (const nativePath of possiblePaths) {
      try {
        nativeBindings = require(nativePath);
        return nativeBindings;
      } catch (e) {
        continue;
      }
    }

    throw new Error('Could not find native bindings');
  } catch (error) {
    throw new Error(`Failed to load native bindings: ${(error as Error).message}`);
  }
}

/**
 * Platform-backed context with durable state and distributed tracing
 */
export class PlatformContext implements Context {
  private stateManager: any; // StateManager from native bindings
  private span: any; // Span from native bindings
  private checkpointCounter = 0;

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
   * Get value from state
   */
  get<T>(key: string, defaultValue?: T): T | undefined {
    // Note: get() is async in native bindings, but our interface expects sync
    // For now, throw an error - callers should use getAsync() instead
    throw new Error('Use getAsync() for platform-backed state');
  }

  /**
   * Get value from state (async version)
   */
  async getAsync<T>(key: string, defaultValue?: T): Promise<T | undefined> {
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
   * Set value in state
   */
  set<T>(key: string, value: T): void {
    // Note: set() is async in native bindings
    throw new Error('Use setAsync() for platform-backed state');
  }

  /**
   * Set value in state (async version)
   */
  async setAsync<T>(key: string, value: T): Promise<void> {
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
   * Delete value from state
   */
  delete(key: string): void {
    throw new Error('Use deleteAsync() for platform-backed state');
  }

  /**
   * Delete value from state (async version)
   */
  async deleteAsync(key: string): Promise<boolean> {
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
    return {
      info: (message: string, meta?: Record<string, any>) => {
        console.log(`[INFO] ${message}`, meta || '');
        this.span.addEvent('log.info', { message, ...meta });
      },
      error: (message: string, meta?: Record<string, any>) => {
        console.error(`[ERROR] ${message}`, meta || '');
        this.span.addEvent('log.error', { message, ...meta });
        this.span.recordError(message);
      },
      warn: (message: string, meta?: Record<string, any>) => {
        console.warn(`[WARN] ${message}`, meta || '');
        this.span.addEvent('log.warn', { message, ...meta });
      },
      debug: (message: string, meta?: Record<string, any>) => {
        console.debug(`[DEBUG] ${message}`, meta || '');
        this.span.addEvent('log.debug', { message, ...meta });
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
   * End the span (call this when context is no longer needed)
   */
  endSpan(): void {
    if (this.span && !this.span.isEnded()) {
      this.span.end();
    }
  }
}
