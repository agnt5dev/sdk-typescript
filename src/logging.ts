/**
 * Logging utilities for AGNT5 TypeScript SDK.
 *
 * Provides ContextLogger (structured context injection) and getLogger/setLogLevel
 * for consistent, NAPI-backed logging that mirrors the Python SDK's _telemetry module.
 */

import type { Logger } from './types.js';
import { getCurrentContext } from './async-context.js';
import { logEvent } from './events.js';
import { getLoadedNativeBindings } from './native-loader.js';
import { getCurrentSpanInfo } from './tracing.js';

// ─── Log level management ────────────────────────────────────────────

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

let _globalLogLevel: LogLevel = (process.env.AGNT5_DEBUG ? 'DEBUG' : 'INFO');

/**
 * Set the global log level for all context loggers.
 * Accepts 'DEBUG', 'INFO', 'WARN', or 'ERROR'.
 */
export function setLogLevel(level: LogLevel): void {
  _globalLogLevel = level;
}

/** Get the current global log level. */
export function getLogLevel(): LogLevel {
  return _globalLogLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[_globalLogLevel];
}

/** Return whether a log level is enabled by the current SDK log level. */
export function isLogLevelEnabled(level: LogLevel): boolean {
  return shouldLog(level);
}

// ─── NAPI binding loader ─────────────────────────────────────────────

function getNativeLogFn() {
  const native = getLoadedNativeBindings();
  return typeof native?.logFromTypescript === 'function'
    ? native.logFromTypescript
    : null;
}

// ─── Trace correlation ───────────────────────────────────────────────

/**
 * Trace and span ids to stamp on a log record, resolved from the ambient run.
 *
 * Every TypeScript log record used to go out with both fields null, so logs
 * could not be correlated to their trace even though the run had one
 * (AGNT5-1073). Two sources, in order:
 *
 *  - an active in-process span, which carries both ids;
 *  - the `trace_id` the runtime stamps on dispatch metadata (sdk-core
 *    `worker.rs` inserts it), which is the id the control plane joins runs and
 *    traces on. No span id is available from this source.
 *
 * Returns nulls outside a run — worker startup logs belong to no trace.
 */
export function currentTraceCorrelation(): {
  traceId: string | null;
  spanId: string | null;
} {
  const span = getCurrentSpanInfo();
  if (span) {
    return { traceId: span.traceId, spanId: span.spanId };
  }
  const traceId = getCurrentContext()?.metadata?.trace_id;
  return { traceId: typeof traceId === 'string' && traceId ? traceId : null, spanId: null };
}

/**
 * The run id of the invocation currently executing, or null outside a run.
 *
 * A logger built with an explicit run id keeps it; every other logger --
 * `getLogger('my-module')` at module scope, anything the SDK itself logs
 * through -- had no run id to send, so those records reached the control plane
 * unattributed and `get_run_logs` could not find them (AGNT5-1070). The worker
 * already binds `runId` on the propagated context for the duration of a
 * dispatch, so reading it here attributes those lines without every log site
 * having to thread the id through.
 */
export function currentRunId(): string | null {
  const runId = getCurrentContext()?.runId;
  return typeof runId === 'string' && runId ? runId : null;
}

// ─── Console formatting ──────────────────────────────────────────────

function formatConsole(level: LogLevel, name: string, message: string, attrs?: Record<string, string>): string {
  const ts = new Date().toISOString();
  const attrStr = attrs && Object.keys(attrs).length > 0
    ? ' ' + Object.entries(attrs).map(([k, v]) => `${k}=${v}`).join(' ')
    : '';
  return `${ts} [${level}] ${name}: ${message}${attrStr}`;
}

// ─── ContextLogger ───────────────────────────────────────────────────

/**
 * Logger with structured context injection.
 *
 * Logs to both console and NAPI/OTLP when available.
 * Extra context (runId, traceId, spanId) is automatically injected.
 *
 * @example
 * ```typescript
 * const logger = new ContextLogger('my-agent', { runId: 'run-123' });
 * logger.info('Processing request', { userId: 'u-456' });
 * ```
 */
export class ContextLogger implements Logger {
  private _name: string;
  private _runId: string | null;
  private _traceId: string | null;
  private _spanId: string | null;
  private _defaultAttrs: Record<string, string>;

  constructor(
    name: string,
    context?: {
      runId?: string;
      traceId?: string;
      spanId?: string;
      attrs?: Record<string, string>;
    },
  ) {
    this._name = name;
    this._runId = context?.runId ?? null;
    this._traceId = context?.traceId ?? null;
    this._spanId = context?.spanId ?? null;
    this._defaultAttrs = context?.attrs ?? {};
  }

  /** Create a child logger with additional context. */
  child(extra: {
    runId?: string;
    traceId?: string;
    spanId?: string;
    attrs?: Record<string, string>;
  }): ContextLogger {
    return new ContextLogger(this._name, {
      runId: extra.runId ?? this._runId ?? undefined,
      traceId: extra.traceId ?? this._traceId ?? undefined,
      spanId: extra.spanId ?? this._spanId ?? undefined,
      attrs: { ...this._defaultAttrs, ...extra.attrs },
    });
  }

  private log(level: LogLevel, message: string, meta?: Record<string, any>): void {
    if (!shouldLog(level)) return;

    // Merge meta into string attrs
    const attrs: Record<string, string> = { ...this._defaultAttrs };
    if (meta) {
      for (const [k, v] of Object.entries(meta)) {
        attrs[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
    }
    const attrOrNull = Object.keys(attrs).length > 0 ? attrs : null;

    // Try NAPI first
    const nativeLog = getNativeLogFn();
    if (nativeLog) {
      // An explicitly supplied id wins; otherwise inherit the ambient run's
      // trace so the record is correlatable (AGNT5-1073) and its run id so the
      // record is attributable to that run (AGNT5-1070).
      const ambient = currentTraceCorrelation();
      nativeLog(
        level,
        `${this._name}: ${message}`,
        this._runId ?? currentRunId(),
        this._traceId ?? ambient.traceId,
        this._spanId ?? ambient.spanId,
        attrOrNull,
      );
    }

    // Emit a log.* journal event tied to the active run so the Studio Logs
    // panel is populated (AGNT5-569). Best-effort: never let logging break the
    // run, and no-op outside a run scope (e.g. worker startup).
    const propagated = getCurrentContext();
    if (propagated?.emitter) {
      const cid = propagated.getCorrelationId?.() ?? this._runId ?? (propagated.correlationId ?? propagated.runId ?? '');
      try {
        void propagated.emitter.emit(
          logEvent(level, this._name, message, cid, null, attrOrNull ?? undefined),
        );
      } catch {
        /* swallow — logging must not interfere with the run */
      }
    }

    // Always log to console
    const formatted = formatConsole(level, this._name, message, attrOrNull ?? undefined);
    switch (level) {
      case 'ERROR': console.error(formatted); break;
      case 'WARN': console.warn(formatted); break;
      case 'DEBUG': console.debug(formatted); break;
      default: console.log(formatted); break;
    }
  }

  info(message: string, meta?: Record<string, any>): void {
    this.log('INFO', message, meta);
  }

  error(message: string, meta?: Record<string, any>): void {
    this.log('ERROR', message, meta);
  }

  warn(message: string, meta?: Record<string, any>): void {
    this.log('WARN', message, meta);
  }

  debug(message: string, meta?: Record<string, any>): void {
    this.log('DEBUG', message, meta);
  }
}

// ─── getLogger ───────────────────────────────────────────────────────

/**
 * Get a named logger with AGNT5-consistent formatting.
 *
 * Respects AGNT5_DEBUG env var and setLogLevel() calls.
 * Logs to NAPI/OTLP when available, always to console.
 *
 * @example
 * ```typescript
 * import { getLogger } from 'agnt5';
 * const logger = getLogger('my-module');
 * logger.info('Ready');
 * logger.debug('Details', { key: 'value' });
 * ```
 */
export function getLogger(name: string): ContextLogger {
  return new ContextLogger(name);
}
