/**
 * Evaluation framework for scoring component outputs.
 *
 * Provides EvalResponse, BatchEval types, EvalContext, and LLMJudge
 * for local and platform-based evaluation workflows.
 */

import { RunError } from './errors.js';
import type { ScorerResultSummary, ScorerRequest, TraceEvent } from './scorer.js';

// ─── EvalContext ─────────────────────────────────────────────────────

/**
 * Context passed to custom evaluation logic.
 * Contains the input/output pair, optional expected value, and trace events.
 */
export class EvalContext {
  readonly input: any;
  readonly output: any;
  readonly expected: any | undefined;
  readonly runId: string | undefined;
  readonly traceId: string | undefined;
  readonly events: TraceEvent[];

  constructor(opts: {
    input: any;
    output: any;
    expected?: any;
    runId?: string;
    traceId?: string;
    events?: TraceEvent[];
  }) {
    this.input = opts.input;
    this.output = opts.output;
    this.expected = opts.expected;
    this.runId = opts.runId;
    this.traceId = opts.traceId;
    this.events = opts.events || [];
  }

  /** Get events filtered by type */
  getEventsByType(eventType: string): TraceEvent[] {
    return this.events.filter(e => e.eventType === eventType);
  }

  /** Get LM call events */
  getLmCalls(): TraceEvent[] {
    return this.events.filter(e => e.eventType === 'lm.call.completed');
  }

  /** Get total tokens across all LM calls */
  getTotalTokens(): number {
    return this.getLmCalls().reduce((sum, e) => sum + (e.data.total_tokens || 0), 0);
  }

  /** Get events for a specific step */
  getStepEvents(stepName: string): TraceEvent[] {
    return this.events.filter(e => e.name === stepName);
  }
}

// ─── EvalResponse ────────────────────────────────────────────────────

/**
 * Response from a single evaluation (client.eval()).
 *
 * Contains the component output, scorer results, and pass/fail status.
 */
export class EvalResponse<T = any> {
  readonly output: T | undefined;
  readonly scores: ScorerResultSummary[];
  readonly passed: boolean;
  readonly runId: string;
  readonly traceId: string | undefined;
  readonly durationMs: number | undefined;
  readonly error: { code: string; message: string; details?: Record<string, any> } | undefined;

  constructor(raw: Record<string, any>) {
    this.output = raw.output as T | undefined;
    this.runId = raw.run_id || raw.runId || '';
    this.traceId = raw.trace_id || raw.traceId;
    this.durationMs = raw.duration_ms || raw.durationMs;

    // Parse error
    if (raw.error) {
      if (typeof raw.error === 'string') {
        this.error = { code: 'EVAL_FAILED', message: raw.error };
      } else {
        this.error = {
          code: raw.error.code || 'EVAL_FAILED',
          message: raw.error.message || String(raw.error),
          details: raw.error.details,
        };
      }
    }

    // Parse scores
    const rawScores = raw.scores || raw.scorer_results || [];
    this.scores = rawScores.map((s: any) => ({
      scorer: s.scorer || s.name || '',
      score: s.score ?? 0,
      passed: s.passed ?? (s.score >= 0.5),
      explanation: s.explanation,
      label: s.label,
      metadata: s.metadata,
    }));

    // Overall pass: all scorers pass and no error
    this.passed = raw.passed ?? (!this.error && this.scores.every(s => s.passed));
  }

  /** True if run completed without error (may have failing scores) */
  get isSuccess(): boolean {
    return !this.error;
  }

  /** True if there was an error */
  get isError(): boolean {
    return !!this.error;
  }

  /** Duration as milliseconds */
  get elapsed(): number | undefined {
    return this.durationMs;
  }

  /** Get score by scorer name */
  getScore(scorerName: string): ScorerResultSummary | undefined {
    return this.scores.find(s => s.scorer === scorerName);
  }

  /** Throw if there was an error */
  raiseForStatus(): void {
    if (this.error) {
      throw new RunError(this.error.message, this.runId, undefined, this.error.code);
    }
  }
}

// ─── Batch Eval Types ────────────────────────────────────────────────

/** Input item for batch evaluation */
export interface BatchEvalItem {
  input: Record<string, any>;
  expected?: any;
  itemId?: string;
  index?: number;
}

/** Result of a single item in a batch evaluation */
export class BatchEvalItemResult {
  readonly index: number;
  readonly runId: string;
  readonly output: any;
  readonly scores: ScorerResultSummary[];
  readonly passed: boolean;
  readonly durationMs: number;
  readonly itemId: string | undefined;
  readonly traceId: string | undefined;
  readonly error: string | undefined;

  constructor(raw: Record<string, any>) {
    this.index = raw.index ?? 0;
    this.runId = raw.run_id || raw.runId || '';
    this.output = raw.output;
    this.durationMs = raw.duration_ms || raw.durationMs || 0;
    this.itemId = raw.item_id || raw.itemId;
    this.traceId = raw.trace_id || raw.traceId;
    this.error = raw.error;

    const rawScores = raw.scores || raw.scorer_results || [];
    this.scores = rawScores.map((s: any) => ({
      scorer: s.scorer || s.name || '',
      score: s.score ?? 0,
      passed: s.passed ?? (s.score >= 0.5),
      explanation: s.explanation,
      label: s.label,
      metadata: s.metadata,
    }));

    this.passed = raw.passed ?? (!this.error && this.scores.every(s => s.passed));
  }

  get isSuccess(): boolean {
    return !this.error;
  }

  get isFailed(): boolean {
    return !!this.error;
  }

  /** Get score by scorer name */
  getScore(scorerName: string): ScorerResultSummary | undefined {
    return this.scores.find(s => s.scorer === scorerName);
  }

  /** Create from an EvalResponse */
  static fromEvalResponse(response: EvalResponse, index: number, itemId?: string): BatchEvalItemResult {
    return new BatchEvalItemResult({
      index,
      run_id: response.runId,
      output: response.output,
      scores: response.scores,
      passed: response.passed,
      duration_ms: response.durationMs || 0,
      item_id: itemId,
      trace_id: response.traceId,
      error: response.error?.message,
    });
  }

  /** Create from an exception */
  static fromException(error: Error, index: number, itemId?: string): BatchEvalItemResult {
    return new BatchEvalItemResult({
      index,
      run_id: '',
      output: undefined,
      scores: [],
      passed: false,
      duration_ms: 0,
      item_id: itemId,
      error: error.message,
    });
  }
}

/** Statistics for a batch evaluation */
export interface BatchEvalStats {
  totalItems: number;
  completedItems: number;
  failedItems: number;
  passedItems: number;
  avgDurationMs: number;
  durationMs: number;
}

/**
 * Result of a batch evaluation (client.batchEval()).
 */
export class BatchEvalResult {
  readonly batchId: string;
  readonly status: string;
  readonly results: BatchEvalItemResult[];
  readonly stats: BatchEvalStats;

  constructor(opts: {
    batchId: string;
    status: string;
    results: BatchEvalItemResult[];
    stats?: BatchEvalStats;
    durationMs?: number;
  }) {
    this.batchId = opts.batchId;
    this.status = opts.status;
    this.results = opts.results.sort((a, b) => a.index - b.index);

    if (opts.stats) {
      this.stats = opts.stats;
    } else {
      // Compute stats from results
      const completed = this.results.filter(r => r.isSuccess).length;
      const failed = this.results.filter(r => r.isFailed).length;
      const passed = this.results.filter(r => r.passed).length;
      const totalDuration = this.results.reduce((s, r) => s + r.durationMs, 0);
      this.stats = {
        totalItems: this.results.length,
        completedItems: completed,
        failedItems: failed,
        passedItems: passed,
        avgDurationMs: this.results.length > 0 ? Math.round(totalDuration / this.results.length) : 0,
        durationMs: opts.durationMs || totalDuration,
      };
    }
  }

  /** Pass rate: fraction of items where passed=true */
  get passRate(): number {
    if (this.results.length === 0) return 0;
    return this.stats.passedItems / this.stats.totalItems;
  }

  get isSuccess(): boolean {
    return this.status === 'completed';
  }

  get isPartialFailure(): boolean {
    return this.status === 'partial_failure';
  }

  /** All outputs sorted by index */
  get outputs(): any[] {
    return this.results.map(r => r.output);
  }

  /** Items that had errors */
  failedItems(): BatchEvalItemResult[] {
    return this.results.filter(r => r.isFailed);
  }

  /** Items where passed=false (may not have errors) */
  failingItems(): BatchEvalItemResult[] {
    return this.results.filter(r => !r.passed);
  }

  /** Items where passed=true */
  passingItems(): BatchEvalItemResult[] {
    return this.results.filter(r => r.passed);
  }
}

// ─── LLM Judge ───────────────────────────────────────────────────────

/** Configuration for an LLM-as-judge scorer */
export interface LLMJudgeConfig {
  criteria: string;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  includeInput?: boolean;
}

/**
 * LLM-as-judge scorer specification.
 *
 * Used with client.eval() to evaluate outputs using an LLM.
 *
 * @example
 * ```typescript
 * const judge = new LLMJudge({
 *   criteria: 'Is the response helpful and accurate?',
 *   model: 'openai/gpt-4o-mini',
 * });
 *
 * const result = await client.eval('my-function', { input: 'hello' }, {
 *   scorers: [judge],
 * });
 * ```
 */
export class LLMJudge {
  readonly criteria: string;
  readonly model: string;
  readonly includeInput: boolean;
  readonly temperature: number;

  constructor(config: LLMJudgeConfig) {
    this.criteria = config.criteria;
    this.model = config.model || 'openai/gpt-4o-mini';
    this.includeInput = config.includeInput ?? false;
    this.temperature = config.temperature ?? 0.0;
  }

  /** Convert to scorer spec for platform API */
  toScorerSpec(): Record<string, any> {
    const [provider, ...modelParts] = this.model.split('/');
    return {
      name: 'llm_judge',
      config: {
        criteria: this.criteria,
        provider,
        model: modelParts.join('/'),
        include_input: this.includeInput,
        temperature: this.temperature,
      },
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Normalize batch eval items to a consistent format.
 *
 * Accepts:
 * 1. BatchEvalItem[] — already normalized
 * 2. { input, expected }[] — dict format
 * 3. Plain input dicts with separate expected list
 */
export function normalizeBatchEvalItems(
  items: Array<Record<string, any> | BatchEvalItem>,
  expected?: any[],
): BatchEvalItem[] {
  return items.map((item, i) => {
    if ('input' in item && (item as any).input !== undefined) {
      return {
        input: (item as BatchEvalItem).input,
        expected: (item as BatchEvalItem).expected ?? expected?.[i],
        itemId: (item as BatchEvalItem).itemId,
        index: (item as BatchEvalItem).index ?? i,
      };
    }
    // Plain input dict
    return {
      input: item as Record<string, any>,
      expected: expected?.[i],
      index: i,
    };
  });
}

/**
 * Normalize scorer specs for the platform API.
 *
 * Accepts strings ("exact_match"), LLMJudge instances, or raw spec dicts.
 */
export function normalizeScorerSpecs(
  scorers: Array<string | LLMJudge | Record<string, any>>,
): Array<Record<string, any>> {
  return scorers.map(s => {
    if (typeof s === 'string') {
      return { name: s };
    }
    if (s instanceof LLMJudge) {
      return s.toScorerSpec();
    }
    return s;
  });
}
