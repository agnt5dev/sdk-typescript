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
  criteria?: string;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  includeInput?: boolean;
  promptTemplate?: string;
  choiceScores?: Record<string, number>;
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
  readonly systemPrompt?: string;
  readonly includeInput: boolean;
  readonly temperature: number;
  readonly promptTemplate?: string;
  readonly choiceScores?: Record<string, number>;

  constructor(config: LLMJudgeConfig) {
    this.criteria = config.criteria || '';
    this.model = config.model || 'openai/gpt-4o-mini';
    this.systemPrompt = config.systemPrompt;
    this.includeInput = config.includeInput ?? false;
    this.temperature = config.temperature ?? 0.0;
    this.promptTemplate = config.promptTemplate;
    this.choiceScores = config.choiceScores;
  }

  /** Convert to scorer spec for platform API */
  toScorerSpec(): Record<string, any> {
    const [provider, model] = splitProviderModel(this.model);
    const config: Record<string, any> = {
      provider,
      model,
      include_input: this.includeInput,
      temperature: this.temperature,
    };
    if (this.criteria) config.criteria = this.criteria;
    if (this.promptTemplate) config.prompt_template = this.promptTemplate;
    if (this.choiceScores) config.choice_scores = this.choiceScores;
    if (this.systemPrompt) config.system_prompt = this.systemPrompt;
    return { name: 'llm_judge', config };
  }
}

export interface CorrectnessConfig {
  model?: string;
  includeInput?: boolean;
  temperature?: number;
  answerField?: string;
  referenceField?: string;
}

/** Managed correctness judge preset. */
export class Correctness {
  readonly model: string;
  readonly includeInput: boolean;
  readonly temperature: number;
  readonly answerField?: string;
  readonly referenceField?: string;

  constructor(config: CorrectnessConfig = {}) {
    this.model = config.model || 'openai/gpt-4o-mini';
    this.includeInput = config.includeInput ?? true;
    this.temperature = config.temperature ?? 0.0;
    this.answerField = config.answerField;
    this.referenceField = config.referenceField;
  }

  toScorerSpec(): Record<string, any> {
    const [provider, model] = splitProviderModel(this.model);
    const config: Record<string, any> = {
      provider,
      model,
      include_input: this.includeInput,
      temperature: this.temperature,
    };
    if (this.answerField) config.answer_field = this.answerField;
    if (this.referenceField) config.reference_field = this.referenceField;
    return { name: 'correctness', config };
  }
}

export interface FaithfulnessConfig {
  contextFields: string[];
  model?: string;
  includeInput?: boolean;
  temperature?: number;
  answerField?: string;
}

/** Managed faithfulness judge preset with configured context fields. */
export class Faithfulness {
  readonly contextFields: string[];
  readonly model: string;
  readonly includeInput: boolean;
  readonly temperature: number;
  readonly answerField?: string;

  constructor(config: FaithfulnessConfig) {
    this.contextFields = config.contextFields;
    this.model = config.model || 'openai/gpt-4o-mini';
    this.includeInput = config.includeInput ?? false;
    this.temperature = config.temperature ?? 0.0;
    this.answerField = config.answerField;
  }

  toScorerSpec(): Record<string, any> {
    const [provider, model] = splitProviderModel(this.model);
    const specConfig: Record<string, any> = {
      provider,
      model,
      context_fields: this.contextFields,
      include_input: this.includeInput,
      temperature: this.temperature,
    };
    if (this.answerField) specConfig.answer_field = this.answerField;
    return { name: 'faithfulness', config: specConfig };
  }
}

function splitProviderModel(value: string): [string, string] {
  const [provider, ...modelParts] = value.split('/');
  if (modelParts.length === 0) return ['openai', value];
  return [provider, modelParts.join('/')];
}

// ─── Trace Assertions ────────────────────────────────────────────

/** Result of checking a single assertion */
export interface AssertionResult {
  name: string;
  passed: boolean;
  explanation: string;
}

/** Trace scorer result */
export interface TraceScorerResult {
  score: number;
  passed: boolean;
  label: string;
  explanation: string;
}

/**
 * Assertion types for glassbox trace evaluation.
 *
 * Mirrors the Rust sdk-core TraceAssertion enum.
 *
 * @example
 * ```typescript
 * const assertions = [
 *   TraceAssertion.maxTokens(1000),
 *   TraceAssertion.maxLmCalls(5),
 *   TraceAssertion.noErrors(),
 * ];
 * const result = traceScorer(trace, assertions);
 * ```
 */
export class TraceAssertion {
  private constructor(
    private readonly _check: (trace: TraceEvent[]) => AssertionResult,
  ) {}

  check(trace: TraceEvent[]): AssertionResult {
    return this._check(trace);
  }

  /** Assert total tokens used is at most `max`. */
  static maxTokens(max: number): TraceAssertion {
    return new TraceAssertion((trace) => {
      const total = trace
        .filter(e => e.eventType === 'lm.call.completed')
        .reduce((sum, e) => sum + (e.data.total_tokens ?? 0), 0);
      return {
        name: `max_tokens(${max})`,
        passed: total <= max,
        explanation: `Token usage: ${total} (max: ${max})`,
      };
    });
  }

  /** Assert number of LLM calls is at most `max`. */
  static maxLmCalls(max: number): TraceAssertion {
    return new TraceAssertion((trace) => {
      const count = trace.filter(e => e.eventType === 'lm.call.completed').length;
      return {
        name: `max_lm_calls(${max})`,
        passed: count <= max,
        explanation: `LLM calls: ${count} (max: ${max})`,
      };
    });
  }

  /** Assert events occur in the specified order (subsequence match). */
  static eventSequence(events: string[]): TraceAssertion {
    return new TraceAssertion((trace) => {
      const types = trace.map(e => e.eventType);
      let j = 0;
      for (const expected of events) {
        while (j < types.length && types[j] !== expected) j++;
        if (j >= types.length) {
          return {
            name: 'event_sequence',
            passed: false,
            explanation: `Missing event '${expected}' in sequence`,
          };
        }
        j++;
      }
      return { name: 'event_sequence', passed: true, explanation: 'All events found in expected order' };
    });
  }

  /** Assert a specific step was memoized (retrieved from cache). */
  static stepMemoized(stepName: string): TraceAssertion {
    return new TraceAssertion((trace) => {
      const memoized = trace
        .filter(e => e.eventType === 'workflow.step.completed' && e.name === stepName)
        .some(e => e.data.is_memoized === true);
      return {
        name: `step_memoized(${stepName})`,
        passed: memoized,
        explanation: memoized
          ? `Step '${stepName}' was memoized`
          : `Step '${stepName}' was NOT memoized`,
      };
    });
  }

  /** Assert no error events occurred. */
  static noErrors(): TraceAssertion {
    const errorTypes = ['run.failed', 'workflow.step.failed', 'agent.failed', 'lm.call.failed', 'function.failed'];
    return new TraceAssertion((trace) => {
      const errors = trace.filter(e => errorTypes.includes(e.eventType));
      return {
        name: 'no_errors',
        passed: errors.length === 0,
        explanation: errors.length === 0 ? 'No error events found' : `Found ${errors.length} error event(s)`,
      };
    });
  }

  /** Assert total duration is under `maxMs` milliseconds. */
  static durationUnder(maxMs: number): TraceAssertion {
    return new TraceAssertion((trace) => {
      if (trace.length === 0) {
        return { name: `duration_under(${maxMs}ms)`, passed: true, explanation: 'Duration: 0ms (no events)' };
      }
      const first = Math.min(...trace.map(e => e.timestampNs));
      const last = Math.max(...trace.map(e => e.timestampNs));
      const durationMs = Math.floor((last - first) / 1_000_000);
      return {
        name: `duration_under(${maxMs}ms)`,
        passed: durationMs <= maxMs,
        explanation: `Duration: ${durationMs}ms (max: ${maxMs}ms)`,
      };
    });
  }

  /** Assert a specific event type occurred at least `min` times. */
  static eventCount(eventType: string, min: number): TraceAssertion {
    return new TraceAssertion((trace) => {
      const count = trace.filter(e => e.eventType === eventType).length;
      return {
        name: `event_count(${eventType}, min=${min})`,
        passed: count >= min,
        explanation: `Event '${eventType}' occurred ${count} times (min: ${min})`,
      };
    });
  }
}

/**
 * Score a trace against multiple assertions.
 *
 * @returns TraceScorerResult with aggregate score (proportion of assertions passed)
 *
 * @example
 * ```typescript
 * const trace = await client.getEvents(runId);
 * const result = traceScorer(trace.events, [
 *   TraceAssertion.maxTokens(1000),
 *   TraceAssertion.noErrors(),
 * ]);
 * console.log(`Score: ${result.score}, Passed: ${result.passed}`);
 * ```
 */
export function traceScorer(trace: TraceEvent[], assertions: TraceAssertion[]): TraceScorerResult {
  if (assertions.length === 0) {
    return { score: 1.0, passed: true, label: 'pass', explanation: 'No assertions to check' };
  }

  const results = assertions.map(a => a.check(trace));
  const passedCount = results.filter(r => r.passed).length;
  const score = passedCount / results.length;
  const allPassed = results.every(r => r.passed);

  const failed = results.filter(r => !r.passed);
  const explanation = failed.length === 0
    ? 'All assertions passed'
    : 'Failed assertions:\n' + failed.map(r => `- ${r.name}: ${r.explanation}`).join('\n');

  return {
    score,
    passed: allPassed,
    label: allPassed ? 'pass' : 'fail',
    explanation,
  };
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
 * Accepts strings ("exact_match"), managed judge presets, or raw spec dicts.
 */
export function normalizeScorerSpecs(
  scorers: Array<string | LLMJudge | Correctness | Faithfulness | Record<string, any>>,
): Array<Record<string, any>> {
  return scorers.map(s => {
    if (typeof s === 'string') {
      return { name: s };
    }
    if (s instanceof LLMJudge || s instanceof Correctness || s instanceof Faithfulness) {
      return s.toScorerSpec();
    }
    return s;
  });
}
