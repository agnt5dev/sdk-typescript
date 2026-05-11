/**
 * Scorer framework for evaluating component outputs.
 *
 * Provides a @scorer decorator, registry, built-in scorers, and
 * a ScorerRequest/ScorerResult protocol matching the Python SDK.
 */

import { randomUUID } from 'crypto';

// ─── Types ───────────────────────────────────────────────────────────

/** Scorer request containing output and optional expected value */
export interface ScorerRequest {
  /** Component output (required) */
  output: any;
  /** Expected output (optional) */
  expected?: any;
  /** Original input (optional) */
  input?: any;
  /** Trace events from execution (optional) */
  trace?: TraceEvent[];
  /** Scorer-specific configuration (optional) */
  config?: Record<string, any>;
}

/** A trace event from component execution */
export interface TraceEvent {
  eventType: string;
  eventId: string;
  correlationId: string;
  parentCorrelationId?: string;
  timestampNs: number;
  data: Record<string, any>;
  name?: string;
}

/** Result of a scorer evaluation */
export class ScorerResult {
  /** Score between 0.0 and 1.0 */
  readonly score: number;
  /** Whether the evaluation passed */
  readonly passed: boolean;
  /** Human-readable label */
  readonly label?: string;
  /** Explanation of the scoring decision */
  readonly explanation?: string;
  /** Additional metadata */
  readonly metadata?: Record<string, any>;

  constructor(opts: {
    score: number;
    passed?: boolean;
    label?: string;
    explanation?: string;
    metadata?: Record<string, any>;
  }) {
    this.score = Math.max(0, Math.min(1, opts.score));
    this.passed = opts.passed ?? this.score >= 0.5;
    this.label = opts.label;
    this.explanation = opts.explanation;
    this.metadata = opts.metadata;
  }

  /** Create a passing result */
  static pass(explanation?: string): ScorerResult {
    return new ScorerResult({ score: 1.0, passed: true, explanation });
  }

  /** Create a failing result */
  static fail(explanation?: string): ScorerResult {
    return new ScorerResult({ score: 0.0, passed: false, explanation });
  }
}

/** Summary of a scorer result (used in EvalResponse) */
export interface ScorerResultSummary {
  scorer: string;
  score: number;
  passed: boolean;
  explanation?: string;
  label?: string;
  metadata?: Record<string, any>;
}

/** Context provided to scorer functions */
export interface ScorerContext {
  runId: string;
  correlationId: string;
  parentCorrelationId?: string;
  attempt: number;
  log: (message: string, extra?: Record<string, any>) => void;
}

/** Scorer handler function signature */
export type ScorerHandler = (
  ctx: ScorerContext,
  request: ScorerRequest,
) => ScorerResult | Promise<ScorerResult>;

/** Configuration for a registered scorer */
export interface ScorerConfig {
  name: string;
  handler: ScorerHandler;
  description: string;
  isAsync: boolean;
  inputSchema?: Record<string, any>;
}

// ─── Scorer decorator ────────────────────────────────────────────────

const SCORER_MARKER = Symbol('scorer');

/**
 * Decorator to register a function as a scorer.
 *
 * @example
 * ```typescript
 * const checkFormat = scorer('format_check', 'Checks output format')(
 *   async (ctx, request) => {
 *     const valid = typeof request.output === 'string';
 *     return new ScorerResult({ score: valid ? 1 : 0, passed: valid });
 *   }
 * );
 * ```
 */
export function scorer(name?: string, description?: string) {
  return function <F extends ScorerHandler>(handler: F): F {
    const scorerName = name || handler.name || 'unnamed_scorer';
    const config: ScorerConfig = {
      name: scorerName,
      handler,
      description: description || '',
      isAsync: handler.constructor.name === 'AsyncFunction',
    };

    (handler as any)[SCORER_MARKER] = config;
    ScorerRegistry.register(config);
    return handler;
  };
}

/** Check if a function is a scorer */
export function isScorer(fn: any): boolean {
  return fn && fn[SCORER_MARKER] !== undefined;
}

/** Get scorer config from a decorated function */
export function getScorerConfig(fn: any): ScorerConfig | undefined {
  return fn?.[SCORER_MARKER];
}

// ─── Registry ────────────────────────────────────────────────────────

/**
 * Global registry for scorer components.
 */
export class ScorerRegistry {
  private static _scorers = new Map<string, ScorerConfig>();

  static register(config: ScorerConfig): void {
    this._scorers.set(config.name, config);
  }

  static get(name: string): ScorerConfig | undefined {
    return this._scorers.get(name);
  }

  static all(): Map<string, ScorerConfig> {
    return new Map(this._scorers);
  }

  static listNames(): string[] {
    return Array.from(this._scorers.keys());
  }

  static clear(): void {
    this._scorers.clear();
  }
}

// ─── Built-in scorers ────────────────────────────────────────────────

/** Exact match: output === expected */
export function exactMatch(request: ScorerRequest): ScorerResult {
  const output = String(request.output ?? '');
  const expected = String(request.expected ?? '');
  const match = output === expected;
  return new ScorerResult({
    score: match ? 1.0 : 0.0,
    passed: match,
    explanation: match ? 'Exact match' : `Expected "${expected}", got "${output}"`,
  });
}

/** Contains: output includes expected substring */
export function contains(request: ScorerRequest): ScorerResult {
  const output = String(request.output ?? '');
  const expected = String(request.expected ?? '');
  const found = output.includes(expected);
  return new ScorerResult({
    score: found ? 1.0 : 0.0,
    passed: found,
    explanation: found ? `Output contains "${expected}"` : `Output does not contain "${expected}"`,
  });
}

/** JSON valid: output is valid JSON */
export function jsonValid(request: ScorerRequest): ScorerResult {
  const output = String(request.output ?? '');
  try {
    JSON.parse(output);
    return new ScorerResult({ score: 1.0, passed: true, explanation: 'Valid JSON' });
  } catch {
    return new ScorerResult({ score: 0.0, passed: false, explanation: 'Invalid JSON' });
  }
}

/** Regex match: output matches the expected regex pattern */
export function regexMatch(request: ScorerRequest): ScorerResult {
  const output = String(request.output ?? '');
  const pattern = String(request.expected ?? '');
  try {
    const re = new RegExp(pattern);
    const match = re.test(output);
    return new ScorerResult({
      score: match ? 1.0 : 0.0,
      passed: match,
      explanation: match ? `Matches /${pattern}/` : `Does not match /${pattern}/`,
    });
  } catch {
    return new ScorerResult({
      score: 0.0,
      passed: false,
      explanation: `Invalid regex pattern: ${pattern}`,
    });
  }
}

/**
 * JSON schema: validate output against a JSON Schema.
 *
 * Schema is read from `request.config.schema`. String outputs are
 * parsed as JSON before validation. The result mirrors the Rust fast
 * path: `valid` / `invalid` / `parse_error` / `config_error` labels,
 * with full error list under `metadata.errors`.
 */
export function jsonSchema(request: ScorerRequest): ScorerResult {
  const schema = request.config?.schema;
  if (schema === undefined) {
    return new ScorerResult({
      score: 0.0,
      passed: false,
      label: 'config_error',
      explanation: 'json_schema requires `config.schema`',
    });
  }

  // Parse string outputs as JSON; structured outputs pass through.
  let value: unknown;
  if (typeof request.output === 'string') {
    try {
      value = JSON.parse(request.output);
    } catch (e) {
      return new ScorerResult({
        score: 0.0,
        passed: false,
        label: 'parse_error',
        explanation: `output is not valid JSON: ${(e as Error).message}`,
      });
    }
  } else {
    value = request.output;
  }

  // Lazy-import ajv so workerd/edge bundles that never call this scorer
  // don't pay the bundle cost. Cache the validator per-schema by JSON
  // identity to amortize repeated calls in a batch.
  const Ajv = (require('ajv') as { default: any }).default;
  let validator;
  try {
    const ajv = new Ajv({ allErrors: true, strict: false });
    validator = ajv.compile(schema as object);
  } catch (e) {
    return new ScorerResult({
      score: 0.0,
      passed: false,
      label: 'config_error',
      explanation: `invalid schema: ${(e as Error).message}`,
    });
  }

  const valid = validator(value);
  if (valid) {
    return new ScorerResult({
      score: 1.0,
      passed: true,
      label: 'valid',
    });
  }
  const errors = (validator.errors ?? []).map(
    (e: { instancePath: string; message?: string }) =>
      `${e.instancePath || '/'}: ${e.message ?? 'invalid'}`,
  );
  return new ScorerResult({
    score: 0.0,
    passed: false,
    label: 'invalid',
    explanation: errors[0] ?? 'schema validation failed',
    metadata: { errors },
  });
}

/**
 * Numeric range: check `output` is numeric and falls in `[min, max]`.
 *
 * Config reads `min`, `max`, and `inclusive` (default true). At least
 * one bound must be set; missing both returns `config_error`. Numeric
 * strings ("42", "3.14") are accepted; non-numeric outputs return
 * `parse_error`.
 */
export function numericRange(request: ScorerRequest): ScorerResult {
  const cfg = request.config ?? {};
  const min = typeof cfg.min === 'number' ? cfg.min : undefined;
  const max = typeof cfg.max === 'number' ? cfg.max : undefined;
  const inclusive = cfg.inclusive === false ? false : true;

  if (min === undefined && max === undefined) {
    return new ScorerResult({
      score: 0.0,
      passed: false,
      label: 'config_error',
      explanation: 'numeric_range requires at least one of `min` or `max`',
    });
  }

  let value: number;
  if (typeof request.output === 'number') {
    value = request.output;
  } else if (typeof request.output === 'string') {
    const parsed = Number(request.output.trim());
    if (Number.isNaN(parsed)) {
      return new ScorerResult({
        score: 0.0,
        passed: false,
        label: 'parse_error',
        explanation: `output is not numeric: ${request.output}`,
      });
    }
    value = parsed;
  } else {
    return new ScorerResult({
      score: 0.0,
      passed: false,
      label: 'parse_error',
      explanation: `output is not numeric: ${JSON.stringify(request.output)}`,
    });
  }

  const aboveMin = min === undefined ? true : inclusive ? value >= min : value > min;
  const belowMax = max === undefined ? true : inclusive ? value <= max : value < max;
  const inRange = aboveMin && belowMax;

  return new ScorerResult({
    score: inRange ? 1.0 : 0.0,
    passed: inRange,
    label: inRange ? 'in_range' : 'out_of_range',
    explanation: `value=${value}, min=${min ?? 'none'}, max=${max ?? 'none'}, inclusive=${inclusive}`,
  });
}

/** Levenshtein distance: normalized similarity score */
export function levenshtein(request: ScorerRequest): ScorerResult {
  const output = String(request.output ?? '');
  const expected = String(request.expected ?? '');

  if (output === expected) {
    return new ScorerResult({ score: 1.0, passed: true, explanation: 'Exact match' });
  }

  const maxLen = Math.max(output.length, expected.length);
  if (maxLen === 0) {
    return new ScorerResult({ score: 1.0, passed: true, explanation: 'Both empty' });
  }

  // Compute edit distance
  const m = output.length;
  const n = expected.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = output[i - 1] === expected[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  const distance = dp[m][n];
  const score = 1 - distance / maxLen;
  return new ScorerResult({
    score,
    passed: score >= 0.5,
    explanation: `Edit distance: ${distance}, similarity: ${(score * 100).toFixed(1)}%`,
  });
}

// Register built-in scorers
ScorerRegistry.register({ name: 'exact_match', handler: (_ctx, req) => exactMatch(req), description: 'Exact string match', isAsync: false });
ScorerRegistry.register({ name: 'contains', handler: (_ctx, req) => contains(req), description: 'Substring containment check', isAsync: false });
ScorerRegistry.register({ name: 'json_valid', handler: (_ctx, req) => jsonValid(req), description: 'Valid JSON check', isAsync: false });
ScorerRegistry.register({ name: 'json_schema', handler: (_ctx, req) => jsonSchema(req), description: 'Validate against a JSON Schema', isAsync: false });
ScorerRegistry.register({ name: 'numeric_range', handler: (_ctx, req) => numericRange(req), description: 'Numeric output is in [min, max]', isAsync: false });
ScorerRegistry.register({ name: 'regex_match', handler: (_ctx, req) => regexMatch(req), description: 'Regex pattern match', isAsync: false });
ScorerRegistry.register({ name: 'levenshtein', handler: (_ctx, req) => levenshtein(req), description: 'Levenshtein edit distance', isAsync: false });

// ─── Runner ──────────────────────────────────────────────────────────

/**
 * Run a scorer by name against a request.
 */
export async function runScorer(
  scorerName: string,
  request: ScorerRequest,
  ctx?: ScorerContext,
): Promise<ScorerResult> {
  const config = ScorerRegistry.get(scorerName);
  if (!config) {
    throw new Error(`Scorer '${scorerName}' not found in registry`);
  }

  const scorerCtx: ScorerContext = ctx || {
    runId: randomUUID(),
    correlationId: randomUUID(),
    attempt: 0,
    log: () => {},
  };

  return config.handler(scorerCtx, request);
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Helper methods for ScorerRequest */
export function getRequestConfig(request: ScorerRequest, key: string, defaultValue?: any): any {
  return request.config?.[key] ?? defaultValue;
}

/** Get trace events by type from a ScorerRequest */
export function getTraceEvents(request: ScorerRequest, eventType: string): TraceEvent[] {
  return (request.trace || []).filter(e => e.eventType === eventType);
}

/** Get total tokens from trace events */
export function getTotalTokens(request: ScorerRequest): number {
  return (request.trace || [])
    .filter(e => e.eventType === 'lm.call.completed')
    .reduce((sum, e) => sum + (e.data.total_tokens || 0), 0);
}
