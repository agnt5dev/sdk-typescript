/**
 * Logging utilities for AGNT5 TypeScript SDK.
 *
 * Provides ContextLogger (structured context injection) and getLogger/setLogLevel
 * for consistent, NAPI-backed logging that mirrors the Python SDK's _telemetry module.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { Logger } from './types.js';

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

// ─── NAPI binding loader ─────────────────────────────────────────────

let _nativeLogFn: ((
  level: string,
  message: string,
  runId: string | null,
  traceId: string | null,
  spanId: string | null,
  attributes: Record<string, string> | null,
) => void) | null | undefined;

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
      nativeLog(level, `${this._name}: ${message}`, this._runId, this._traceId, this._spanId, attrOrNull);
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
