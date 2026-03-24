/**
 * Tracing utilities for AGNT5 components.
 *
 * Provides span creation and context propagation using AsyncLocalStorage.
 * Currently log-only; Phase D will connect to NAPI Span / OpenTelemetry.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

// ─── Span context propagation ────────────────────────────────────────

export interface SpanInfo {
  traceId: string;
  spanId: string;
}

const spanStorage = new AsyncLocalStorage<SpanInfo>();

/** Get the current span info (if inside a span scope) */
export function getCurrentSpanInfo(): SpanInfo | undefined {
  return spanStorage.getStore();
}

// ─── Span class ──────────────────────────────────────────────────────

/**
 * Represents an active tracing span.
 */
export class Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  readonly componentType: string;
  readonly parentSpanId: string | null;
  private _attributes: Record<string, string> = {};
  private _startTime: number;
  private _endTime: number | null = null;
  private _error: Error | null = null;

  constructor(
    name: string,
    componentType: string,
    parentInfo?: SpanInfo,
    attributes?: Record<string, string>,
  ) {
    this.traceId = parentInfo?.traceId || randomUUID();
    this.spanId = randomUUID();
    this.name = name;
    this.componentType = componentType;
    this.parentSpanId = parentInfo?.spanId || null;
    this._startTime = Date.now();
    if (attributes) {
      this._attributes = { ...attributes };
    }
  }

  /** Set an attribute on this span */
  setAttribute(key: string, value: string): void {
    this._attributes[key] = value;
  }

  /** Record an exception on this span */
  recordException(error: Error): void {
    this._error = error;
    this._attributes['error.type'] = error.name;
    this._attributes['error.message'] = error.message;
  }

  /** End the span (records duration) */
  end(): void {
    this._endTime = Date.now();
    // TODO: Phase D — send span to NAPI/OTel exporter
  }

  /** Duration in milliseconds (undefined if span not ended) */
  get durationMs(): number | undefined {
    if (this._endTime === null) return undefined;
    return this._endTime - this._startTime;
  }

  get attributes(): Record<string, string> {
    return { ...this._attributes };
  }
}

// ─── withSpan ────────────────────────────────────────────────────────

/**
 * Execute a function within a new tracing span.
 *
 * Automatically sets the span as current context for nested spans,
 * records exceptions, and ends the span when the function completes.
 *
 * @example
 * ```typescript
 * const result = await withSpan('db-query', async (span) => {
 *   span.setAttribute('table', 'users');
 *   return await db.query('SELECT * FROM users');
 * });
 * ```
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => T | Promise<T>,
  options?: { componentType?: string; attributes?: Record<string, string> },
): Promise<T> {
  const parentInfo = getCurrentSpanInfo();
  const span = new Span(
    name,
    options?.componentType || 'operation',
    parentInfo,
    options?.attributes,
  );

  const spanInfo: SpanInfo = { traceId: span.traceId, spanId: span.spanId };

  try {
    const result = await spanStorage.run(spanInfo, () => fn(span));
    span.end();
    return result;
  } catch (error) {
    span.recordException(error as Error);
    span.end();
    throw error;
  }
}

// ─── spanContext ─────────────────────────────────────────────────────

/**
 * Create a span and return it for manual control.
 * The span is set as the current context for nested operations.
 *
 * @example
 * ```typescript
 * const span = spanContext('process-batch', { componentType: 'workflow' });
 * try {
 *   // ... do work ...
 *   span.setAttribute('items', String(items.length));
 * } catch (e) {
 *   span.recordException(e);
 *   throw e;
 * } finally {
 *   span.end();
 * }
 * ```
 */
export function spanContext(
  name: string,
  options?: { componentType?: string; attributes?: Record<string, string> },
): Span {
  const parentInfo = getCurrentSpanInfo();
  return new Span(
    name,
    options?.componentType || 'operation',
    parentInfo,
    options?.attributes,
  );
}

// ─── span decorator ─────────────────────────────────────────────────

/**
 * Decorator factory that wraps an async function in a tracing span.
 *
 * @example
 * ```typescript
 * const processOrder = span('process-order')(async (orderId: string) => {
 *   // ... function body automatically traced ...
 * });
 * ```
 */
export function span(
  name?: string,
  options?: { componentType?: string; attributes?: Record<string, string> },
): <T extends (...args: any[]) => Promise<any>>(fn: T) => T {
  return <T extends (...args: any[]) => Promise<any>>(fn: T): T => {
    const spanName = name || fn.name || 'anonymous';

    const wrapped = async function (this: any, ...args: any[]) {
      return withSpan(spanName, () => fn.apply(this, args), options);
    };

    // Preserve the original function name
    Object.defineProperty(wrapped, 'name', { value: fn.name });
    return wrapped as unknown as T;
  };
}
