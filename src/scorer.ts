/**
 * Scorer framework for evaluating component outputs.
 *
 * Provides a @scorer decorator, registry, built-in scorers, and
 * a ScorerRequest/ScorerResult protocol matching the Python SDK.
 */

import { randomUUID } from 'crypto';
import Ajv from 'ajv';

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

export type ScorerScope = 'item' | 'run' | 'trace' | 'span' | 'session' | 'fleet_run';

/** Configuration for a registered scorer */
export interface ScorerConfig {
  name: string;
  handler: ScorerHandler;
  description: string;
  scope: ScorerScope;
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
export function scorer(name?: string, description?: string, scope: ScorerScope = 'item') {
  return function <F extends ScorerHandler>(handler: F): F {
    const scorerName = name || handler.name || 'unnamed_scorer';
    const config: ScorerConfig = {
      name: scorerName,
      handler,
      description: description || '',
      scope,
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

/**
 * Contains: output includes a configured pattern.
 *
 * Reads `request.config.pattern` (canonical, matches Rust + Python).
 * Falls back to `request.expected` for backward compatibility with
 * older TS callers; that path will be removed once external usage
 * migrates. `config.case_sensitive` defaults to true.
 */
export function contains(request: ScorerRequest): ScorerResult {
  const output = String(request.output ?? '');
  const pattern = String(
    request.config?.pattern ?? request.expected ?? '',
  );
  const caseSensitive = request.config?.case_sensitive !== false;
  const haystack = caseSensitive ? output : output.toLowerCase();
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  const found = haystack.includes(needle);
  return new ScorerResult({
    score: found ? 1.0 : 0.0,
    passed: found,
    explanation: found ? `Output contains "${pattern}"` : `Output does not contain "${pattern}"`,
  });
}

/**
 * JSON valid: output is valid JSON.
 *
 * Matches the Rust impl (`sdk-core::eval::deterministic::json_valid`):
 * a structured JSON value (object / array / number / bool / null) is
 * already valid by definition. Only string outputs are parsed.
 */
export function jsonValid(request: ScorerRequest): ScorerResult {
  if (typeof request.output === 'string') {
    try {
      JSON.parse(request.output);
      return new ScorerResult({ score: 1.0, passed: true, explanation: 'Valid JSON' });
    } catch {
      return new ScorerResult({ score: 0.0, passed: false, explanation: 'Invalid JSON' });
    }
  }
  // Anything that isn't a string is already a structured JSON Value —
  // including objects, arrays, numbers, booleans, and null.
  return new ScorerResult({ score: 1.0, passed: true, explanation: 'Valid JSON' });
}

/**
 * Regex match: output matches a regex pattern.
 *
 * Reads `request.config.pattern` (canonical). Falls back to
 * `request.expected` for backward compatibility.
 */
export function regexMatch(request: ScorerRequest): ScorerResult {
  const output = String(request.output ?? '');
  const pattern = String(
    request.config?.pattern ?? request.expected ?? '',
  );
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

  // ajv is imported statically at the top of the file — the dynamic
  // require() form was incompatible with the package's "type": "module"
  // declaration and threw ReferenceError under Node's ESM loader.
  // Bundle cost (~120KB minified) is the same either way; per-call we
  // re-compile because Ajv is stateful per schema and schema isn't
  // necessarily JSON-identical across calls.
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

// ─── LLM-as-judge ────────────────────────────────────────────────────

/**
 * Default system prompt for `llm_judge`. Mirrors the Rust + Python
 * implementations so a judge scored in any language produces the same
 * baseline output. Override via `config.system_prompt`.
 */
const LLM_JUDGE_DEFAULT_SYSTEM_PROMPT = `You are an expert evaluator. Your task is to evaluate the given output based on the provided criteria.

Respond with a JSON object containing:
- "score": a number between 0.0 and 1.0
- "passed": boolean (true if score >= 0.7)
- "explanation": brief explanation of your evaluation

Respond ONLY with the JSON object, no other text.`;

const CORRECTNESS_JUDGE_CRITERIA =
  'Evaluate whether the output correctly answers the input and matches the expected output. Score 1.0 for fully correct answers, 0.5 for partially correct answers, and 0.0 for incorrect or unsupported answers.';

const FAITHFULNESS_JUDGE_CRITERIA =
  'Evaluate whether the output is faithful to the provided context. Penalize claims that are unsupported, contradicted by context, or omit critical context needed for the answer.';

/**
 * LLM-as-judge scorer: ask an LM to score the output against criteria.
 *
 * Async. Reads `config`:
 *   - `criteria`: string (required) — evaluation rubric.
 *   - `provider`: 'openai' | 'anthropic' | 'google' | 'mistral' | … —
 *     selects the LM provider (default 'openai'). Credentials are read
 *     from the provider's env vars; pass an `LM` via
 *     `ctx.llmJudgeLm` to override.
 *   - `model`: model name (e.g. 'gpt-4o-mini'), required.
 *   - `system_prompt`: optional override for the judge system prompt.
 *   - `temperature`: number, default 0.0.
 *   - `include_input`: bool, default false — include `request.input` in
 *     the prompt.
 *
 * Mirrors `sdk-core::eval::llm_judge` and `agnt5.eval.llm_judge` —
 * same default temperature, same default prompt, same JSON-response
 * parsing rules, same parse_error label on bad output.
 */
export async function llmJudge(
  request: ScorerRequest,
  ctx?: ScorerContext,
): Promise<ScorerResult> {
  const cfg = request.config ?? {};
  const criteria = typeof cfg.criteria === 'string' ? cfg.criteria : '';
  const promptTemplate = typeof cfg.prompt_template === 'string' ? cfg.prompt_template : '';
  if (!criteria && !promptTemplate) {
    return new ScorerResult({
      score: 0.0,
      passed: false,
      label: 'config_error',
      explanation: 'llm_judge requires `config.criteria` or `config.prompt_template`',
    });
  }
  const providerName = typeof cfg.provider === 'string' ? cfg.provider : 'openai';
  const modelName = typeof cfg.model === 'string' ? cfg.model : '';
  if (!modelName) {
    return new ScorerResult({
      score: 0.0,
      passed: false,
      label: 'config_error',
      explanation: 'llm_judge requires `config.model`',
    });
  }
  const systemPrompt =
    typeof cfg.system_prompt === 'string' ? cfg.system_prompt : LLM_JUDGE_DEFAULT_SYSTEM_PROMPT;
  const temperature = typeof cfg.temperature === 'number' ? cfg.temperature : 0.0;
  const includeInput = cfg.include_input === true;
  const contextData = cfg.context_data ?? cfg.context;
  const choiceScoresResult = parseChoiceScores(cfg.choice_scores);
  if (choiceScoresResult.error) {
    return new ScorerResult({
      score: 0.0,
      passed: false,
      label: 'config_error',
      explanation: choiceScoresResult.error,
    });
  }
  const choiceScores = choiceScoresResult.scores;

  // Build the user prompt the same way Rust/Python do — keeps judge
  // verdicts comparable across languages.
  let userContent: string;
  if (promptTemplate) {
    const rendered = renderPromptTemplate(promptTemplate, {
      input: request.input,
      output: request.output,
      expected: request.expected,
      context: contextData,
    });
    if (rendered.error) {
      return new ScorerResult({
        score: 0.0,
        passed: false,
        label: 'config_error',
        explanation: rendered.error,
      });
    }
    userContent = `${rendered.text!.trimEnd()}\n\n`;
  } else {
    userContent = `## Evaluation Criteria\n${criteria}\n\n`;
    if (includeInput && request.input !== undefined && request.input !== null) {
      userContent += `## Input\n${formatJudgeValue(request.input)}\n\n`;
    }
    if (contextData !== undefined && contextData !== null) {
      userContent += `## Context\n${formatJudgeValue(contextData)}\n\n`;
    }
    userContent += `## Output to Evaluate\n${formatJudgeValue(request.output)}\n\n`;
    if (request.expected !== undefined && request.expected !== null) {
      userContent += `## Expected Output (Reference)\n${formatJudgeValue(request.expected)}\n\n`;
    }
  }
  if (choiceScores) {
    userContent += `Choose exactly one label from: ${Object.keys(choiceScores).sort().join(', ')}. Return that label in the JSON \`label\` field. The platform will map labels to scores.\n\n`;
  }
  userContent += 'Please evaluate the output and respond with a JSON object.';

  // Tests / advanced usage can inject an LM via the context. Default
  // path constructs one per call from env credentials.
  let lm = (ctx as { llmJudgeLm?: { generate: (req: any) => Promise<any> } } | undefined)?.llmJudgeLm;
  if (!lm) {
    try {
      lm = await makeLmForProvider(providerName);
    } catch (e) {
      return new ScorerResult({
        score: 0.0,
        passed: false,
        label: 'config_error',
        explanation: `llm_judge: unsupported provider '${providerName}': ${(e as Error).message}`,
      });
    }
  }

  let response: { text: string };
  try {
    response = await lm.generate({
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature,
    });
  } catch (e) {
    return new ScorerResult({
      score: 0.0,
      passed: false,
      label: 'error',
      explanation: `LLM call failed: ${(e as Error).message}`,
    });
  }
  return applyChoiceScores(parseLlmJudgeResponse(response.text ?? ''), choiceScores);
}

function formatJudgeValue(v: any): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

async function makeLmForProvider(
  providerName: string,
): Promise<{ generate: (req: any) => Promise<any> }> {
  // Dynamic ESM import keeps the LM bindings out of bundles that never
  // call llm_judge — important for wasm/edge runtimes where the native
  // module isn't loadable. `await import()` is the ESM-correct shape;
  // the previous bare `require()` threw ReferenceError under Node's
  // pure ESM loader since this package is "type": "module".
  const { LM } = await import('./lm.js');
  switch (providerName.toLowerCase()) {
    case 'openai':
      return LM.openai();
    case 'anthropic':
      return LM.anthropic();
    case 'google':
      return LM.google();
    case 'mistral':
      return LM.mistral();
    case 'groq':
      return LM.groq();
    case 'deepseek':
      return LM.deepseek();
    case 'openrouter':
      return LM.openrouter();
    case 'ollama':
      return LM.ollama();
    default:
      throw new Error(`provider '${providerName}' is not in the supported set`);
  }
}

function parseLlmJudgeResponse(content: string): ScorerResult {
  const jsonStr = extractJudgeJson(content);
  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return new ScorerResult({
      score: 0.0,
      passed: false,
      label: 'parse_error',
      explanation: `Could not parse LLM response: ${content}`,
      metadata: { raw_response: content, error: (e as Error).message },
    });
  }
  const rawScore = typeof parsed.score === 'number' ? parsed.score : 0;
  const score = Math.max(0, Math.min(1, rawScore));
  const passed =
    typeof parsed.passed === 'boolean' ? parsed.passed : score >= 0.7;
  const explanation =
    typeof parsed.explanation === 'string' ? parsed.explanation : undefined;
  const label = typeof parsed.label === 'string' ? parsed.label : undefined;
  // Metadata keeps any extra keys the LLM produced, dropping the ones
  // we've already promoted to top-level fields.
  const extras: Record<string, any> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k !== 'score' && k !== 'passed' && k !== 'explanation' && k !== 'label') {
      extras[k] = v;
    }
  }
  return new ScorerResult({
    score,
    passed,
    label,
    explanation,
    metadata: Object.keys(extras).length > 0 ? extras : undefined,
  });
}

function extractJudgeJson(raw: string): string {
  const s = raw.trim();
  // Markdown-fenced JSON blocks.
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) return fenceMatch[1].trim();
  // First balanced-looking JSON object.
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end >= start) {
    return s.slice(start, end + 1);
  }
  return s;
}

function renderPromptTemplate(
  template: string,
  values: Record<string, any>,
): { text?: string; error?: string } {
  try {
    return {
      text: template.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, selector) =>
        formatJudgeValue(templateSelectedValue(values, String(selector).trim())),
      ),
    };
  } catch (e) {
    return { error: `prompt_template variable not found: ${(e as Error).message}` };
  }
}

function templateSelectedValue(values: Record<string, any>, selector: string): any {
  const [root, ...parts] = selector.split('.');
  if (!(root in values)) throw new Error(selector);
  let value = values[root];
  for (const part of parts) {
    if (!part) throw new Error(selector);
    if (value && typeof value === 'object' && !Array.isArray(value) && part in value) {
      value = value[part];
      continue;
    }
    if (Array.isArray(value) && /^\d+$/.test(part)) {
      const index = Number(part);
      if (index < value.length) {
        value = value[index];
        continue;
      }
    }
    throw new Error(selector);
  }
  return value;
}

function parseChoiceScores(raw: any): { scores?: Record<string, number>; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'llm_judge `config.choice_scores` must be an object mapping label to score' };
  }
  const scores: Record<string, number> = {};
  for (const [label, score] of Object.entries(raw)) {
    if (!label.trim()) {
      return { error: 'llm_judge `config.choice_scores` labels must be non-empty' };
    }
    if (typeof score !== 'number' || score < 0 || score > 1) {
      return { error: `llm_judge choice score for label '${label}' must be between 0 and 1` };
    }
    scores[label] = score;
  }
  if (Object.keys(scores).length === 0) {
    return { error: 'llm_judge `config.choice_scores` must include at least one label' };
  }
  return { scores };
}

function applyChoiceScores(
  result: ScorerResult,
  choiceScores?: Record<string, number>,
): ScorerResult {
  if (!choiceScores || result.label === 'parse_error' || result.label === 'config_error') {
    return result;
  }
  const labels = Object.keys(choiceScores).sort();
  if (!result.label || !(result.label in choiceScores)) {
    return new ScorerResult({
      score: 0.0,
      passed: false,
      label: 'invalid_label',
      explanation: `Judge returned label ${JSON.stringify(result.label)}; expected one of: ${labels.join(', ')}`,
      metadata: {
        ...(result.metadata ?? {}),
        allowed_labels: labels,
        ...(result.label ? { invalid_label: result.label } : {}),
      },
    });
  }
  const score = Math.max(0, Math.min(1, choiceScores[result.label]));
  return new ScorerResult({
    score,
    passed: score >= 0.7,
    label: result.label,
    explanation: result.explanation,
    metadata: {
      ...(result.metadata ?? {}),
      choice_scores: choiceScores,
      selected_label: result.label,
    },
  });
}

export async function correctness(
  request: ScorerRequest,
  ctx?: ScorerContext,
): Promise<ScorerResult> {
  const cfg = request.config ?? {};
  let output: any;
  let expected: any;
  try {
    output = optionalSelectedValue(request, cfg.answer_field, request.output);
    expected = optionalSelectedValue(request, cfg.reference_field, request.expected);
  } catch (e) {
    return judgeConfigError(`correctness field selector not found: ${(e as Error).message}`);
  }
  if (expected === undefined || expected === null) {
    return judgeConfigError('correctness requires expected output or config.reference_field');
  }
  const result = await llmJudge({
    ...request,
    output,
    expected,
    config: {
      provider: cfg.provider ?? 'openai',
      model: cfg.model ?? 'gpt-4o-mini',
      criteria: CORRECTNESS_JUDGE_CRITERIA,
      include_input: cfg.include_input ?? true,
      temperature: cfg.temperature ?? 0.0,
    },
  }, ctx);
  return mergeJudgeMetadata(result, {
    judge_preset: 'correctness',
  });
}

export async function faithfulness(
  request: ScorerRequest,
  ctx?: ScorerContext,
): Promise<ScorerResult> {
  const cfg = request.config ?? {};
  const fields = contextFields(cfg);
  if (fields.length === 0) {
    return judgeConfigError('faithfulness requires config.context_fields or config.context_field');
  }
  let output: any;
  const context: Record<string, any> = {};
  try {
    output = optionalSelectedValue(request, cfg.answer_field, request.output);
    for (const field of fields) {
      context[field] = selectedValue(request, field);
    }
  } catch (e) {
    return judgeConfigError(`faithfulness field selector not found: ${(e as Error).message}`);
  }
  const result = await llmJudge({
    ...request,
    output,
    config: {
      provider: cfg.provider ?? 'openai',
      model: cfg.model ?? 'gpt-4o-mini',
      criteria: FAITHFULNESS_JUDGE_CRITERIA,
      include_input: cfg.include_input ?? false,
      temperature: cfg.temperature ?? 0.0,
      context_data: context,
    },
  }, ctx);
  return mergeJudgeMetadata(result, {
    judge_preset: 'faithfulness',
    context_fields: fields,
  });
}

function judgeConfigError(explanation: string): ScorerResult {
  return new ScorerResult({
    score: 0.0,
    passed: false,
    label: 'config_error',
    explanation,
  });
}

function mergeJudgeMetadata(result: ScorerResult, metadata: Record<string, any>): ScorerResult {
  return new ScorerResult({
    score: result.score,
    passed: result.passed,
    label: result.label,
    explanation: result.explanation,
    metadata: { ...(result.metadata ?? {}), ...metadata },
  });
}

function contextFields(config: Record<string, any>): string[] {
  const fields: string[] = [];
  if (typeof config.context_field === 'string' && config.context_field.trim()) {
    fields.push(config.context_field.trim());
  }
  if (Array.isArray(config.context_fields)) {
    for (const field of config.context_fields) {
      if (typeof field === 'string' && field.trim()) fields.push(field.trim());
    }
  }
  return fields;
}

function optionalSelectedValue(request: ScorerRequest, selector: any, fallback: any): any {
  if (selector === undefined || selector === null || selector === '') return fallback;
  if (typeof selector !== 'string') throw new Error(String(selector));
  return selectedValue(request, selector);
}

function selectedValue(request: ScorerRequest, selector: string): any {
  const [root, ...parts] = selector.trim().split('.');
  if (!root || parts.length === 0) throw new Error(selector);
  let value: any;
  switch (root) {
    case 'input':
      value = request.input;
      break;
    case 'output':
      value = request.output;
      break;
    case 'expected':
      value = request.expected;
      break;
    default:
      throw new Error(selector);
  }
  for (const part of parts) {
    if (value && typeof value === 'object' && !Array.isArray(value) && part in value) {
      value = value[part];
      continue;
    }
    if (Array.isArray(value) && /^\d+$/.test(part)) {
      const index = Number(part);
      if (index < value.length) {
        value = value[index];
        continue;
      }
    }
    throw new Error(selector);
  }
  return value;
}

// Register built-in scorers
ScorerRegistry.register({ name: 'exact_match', handler: (_ctx, req) => exactMatch(req), description: 'Exact string match', scope: 'item', isAsync: false });
ScorerRegistry.register({ name: 'contains', handler: (_ctx, req) => contains(req), description: 'Substring containment check', scope: 'item', isAsync: false });
ScorerRegistry.register({ name: 'json_valid', handler: (_ctx, req) => jsonValid(req), description: 'Valid JSON check', scope: 'item', isAsync: false });
ScorerRegistry.register({ name: 'json_schema', handler: (_ctx, req) => jsonSchema(req), description: 'Validate against a JSON Schema', scope: 'item', isAsync: false });
ScorerRegistry.register({ name: 'numeric_range', handler: (_ctx, req) => numericRange(req), description: 'Numeric output is in [min, max]', scope: 'item', isAsync: false });
ScorerRegistry.register({ name: 'regex_match', handler: (_ctx, req) => regexMatch(req), description: 'Regex pattern match', scope: 'item', isAsync: false });
ScorerRegistry.register({ name: 'levenshtein', handler: (_ctx, req) => levenshtein(req), description: 'Levenshtein edit distance', scope: 'item', isAsync: false });
ScorerRegistry.register({ name: 'llm_judge', handler: (ctx, req) => llmJudge(req, ctx), description: 'LLM-as-judge: ask an LM to score the output against criteria', scope: 'item', isAsync: true });
ScorerRegistry.register({ name: 'correctness', handler: (ctx, req) => correctness(req, ctx), description: 'Managed LLM judge preset for answer correctness', scope: 'item', isAsync: true });
ScorerRegistry.register({ name: 'faithfulness', handler: (ctx, req) => faithfulness(req, ctx), description: 'Managed LLM judge preset for faithfulness to configured context', scope: 'item', isAsync: true });

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
