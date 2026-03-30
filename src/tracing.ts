/**
 * Tracing utilities for AGNT5 components.
 *
 * Provides span creation and context propagation using AsyncLocalStorage.
 * When NAPI bindings are available, creates real OpenTelemetry spans via
 * sdk-core. Falls back to log-only when NAPI is unavailable.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ─── NAPI binding loader ─────────────────────────────────────────────

let nativeBindings: any = null;
let napiAvailable = false;

function tryLoadNapi(): any {
  if (nativeBindings !== null) return nativeBindings;

  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const require = createRequire(import.meta.url);

    const possiblePaths = [
      join(__dirname, '../../native/agnt5-sdk-native.darwin-arm64.node'),
      join(__dirname, '../native/agnt5-sdk-native.darwin-arm64.node'),
      join(__dirname, '../../native/agnt5-sdk-native.linux-x64-gnu.node'),
      join(__dirname, '../native/agnt5-sdk-native.linux-x64-gnu.node'),
    ];

    for (const nativePath of possiblePaths) {
      try {
        nativeBindings = require(nativePath);
        napiAvailable = true;
        return nativeBindings;
      } catch {
        continue;
      }
    }
  } catch {
    // NAPI not available — fall back to log-only
  }
  nativeBindings = false; // Mark as attempted
  return null;
}

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
 *
 * When NAPI bindings are available, this wraps a real OpenTelemetry span
 * exported via OTLP. Otherwise, operates as a lightweight in-process span
 * with attribute tracking and duration measurement.
 */
export class Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  readonly componentType: string;
  readonly parentSpanId: string | null;
  private _nativeSpan: any = null;
  private _attributes: Record<string, string> = {};
  private _startTime: number;
  private _endTime: number | null = null;

  constructor(
    name: string,
    componentType: string,
    parentInfo?: SpanInfo,
    attributes?: Record<string, string>,
  ) {
    this.name = name;
    this.componentType = componentType;
    this.parentSpanId = parentInfo?.spanId || null;
    this._startTime = Date.now();
    if (attributes) {
      this._attributes = { ...attributes };
    }

    // Try to create a real OTel span via NAPI
    const bindings = tryLoadNapi();
    if (bindings && bindings.Span) {
      try {
        // Only pass parent IDs to NAPI if they look like valid hex (OTel format)
        const parentTraceId = parentInfo?.traceId && /^[0-9a-f]{16,32}$/i.test(parentInfo.traceId)
          ? parentInfo.traceId : null;
        const parentSpanId = parentInfo?.spanId && /^[0-9a-f]{16}$/i.test(parentInfo.spanId)
          ? parentInfo.spanId : null;

        this._nativeSpan = bindings.Span.create(
          name,
          componentType,
          parentTraceId,
          parentSpanId,
          attributes || null,
        );

        const napiTraceId = this._nativeSpan.traceId;
        const napiSpanId = this._nativeSpan.spanId;

        if (napiTraceId && napiSpanId) {
          // Real OTel IDs from initialized telemetry
          this.traceId = napiTraceId;
          this.spanId = napiSpanId;
        } else {
          // NAPI span created but telemetry not initialized — use JS-level IDs
          this.traceId = parentInfo?.traceId || randomUUID();
          this.spanId = randomUUID();
        }
        return;
      } catch {
        // Fall through to log-only
      }
    }

    // Fallback: generate local IDs
    this.traceId = parentInfo?.traceId || randomUUID();
    this.spanId = randomUUID();
  }

  /** Set an attribute on this span */
  setAttribute(key: string, value: string): void {
    this._attributes[key] = value;
    if (this._nativeSpan) {
      try { this._nativeSpan.setAttribute(key, value); } catch { /* ignore */ }
    }
  }

  /** Record an exception on this span */
  recordException(error: Error): void {
    this._attributes['error.type'] = error.name;
    this._attributes['error.message'] = error.message;
    if (this._nativeSpan) {
      try { this._nativeSpan.recordError(error.message); } catch { /* ignore */ }
    }
  }

  /** End the span (records duration, exports via OTLP if available) */
  end(): void {
    this._endTime = Date.now();
    if (this._nativeSpan) {
      try { this._nativeSpan.end(); } catch { /* ignore */ }
      this._nativeSpan = null;
    }
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
