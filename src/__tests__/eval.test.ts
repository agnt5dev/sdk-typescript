import { describe, it, expect } from 'vitest';
import {
  EvalContext,
  EvalResponse,
  BatchEvalItemResult,
  BatchEvalResult,
  LLMJudge,
  Correctness,
  Faithfulness,
  normalizeBatchEvalItems,
  normalizeScorerSpecs,
} from '../eval.js';

describe('EvalContext', () => {
  it('should store input/output/expected', () => {
    const ctx = new EvalContext({
      input: { name: 'Alice' },
      output: 'Hello, Alice!',
      expected: 'Hello, Alice!',
      runId: 'r1',
    });
    expect(ctx.input.name).toBe('Alice');
    expect(ctx.output).toBe('Hello, Alice!');
    expect(ctx.expected).toBe('Hello, Alice!');
    expect(ctx.runId).toBe('r1');
  });

  it('should filter events by type', () => {
    const ctx = new EvalContext({
      input: {},
      output: 'ok',
      events: [
        { eventType: 'lm.call.completed', eventId: '1', correlationId: 'c1', timestampNs: 0, data: { total_tokens: 100 } },
        { eventType: 'run.started', eventId: '2', correlationId: 'c2', timestampNs: 0, data: {} },
        { eventType: 'lm.call.completed', eventId: '3', correlationId: 'c3', timestampNs: 0, data: { total_tokens: 50 } },
      ],
    });

    expect(ctx.getEventsByType('lm.call.completed')).toHaveLength(2);
    expect(ctx.getLmCalls()).toHaveLength(2);
    expect(ctx.getTotalTokens()).toBe(150);
  });

  it('should filter by step name', () => {
    const ctx = new EvalContext({
      input: {},
      output: 'ok',
      events: [
        { eventType: 'step.started', eventId: '1', correlationId: 'c1', timestampNs: 0, data: {}, name: 'step1' },
        { eventType: 'step.completed', eventId: '2', correlationId: 'c2', timestampNs: 0, data: {}, name: 'step1' },
        { eventType: 'step.started', eventId: '3', correlationId: 'c3', timestampNs: 0, data: {}, name: 'step2' },
      ],
    });

    expect(ctx.getStepEvents('step1')).toHaveLength(2);
    expect(ctx.getStepEvents('step2')).toHaveLength(1);
  });
});

describe('EvalResponse', () => {
  it('should parse successful response', () => {
    const resp = new EvalResponse({
      output: 'Hello!',
      run_id: 'r1',
      trace_id: 't1',
      duration_ms: 42,
      passed: true,
      scores: [
        { scorer: 'exact_match', score: 1.0, passed: true },
      ],
    });

    expect(resp.isSuccess).toBe(true);
    expect(resp.isError).toBe(false);
    expect(resp.passed).toBe(true);
    expect(resp.output).toBe('Hello!');
    expect(resp.runId).toBe('r1');
    expect(resp.traceId).toBe('t1');
    expect(resp.elapsed).toBe(42);
    expect(resp.scores).toHaveLength(1);
    expect(resp.scores[0].scorer).toBe('exact_match');
  });

  it('should parse error response', () => {
    const resp = new EvalResponse({
      run_id: 'r1',
      error: 'Something went wrong',
    });

    expect(resp.isSuccess).toBe(false);
    expect(resp.isError).toBe(true);
    expect(resp.error?.message).toBe('Something went wrong');
  });

  it('should raise for status on error', () => {
    const resp = new EvalResponse({
      run_id: 'r1',
      error: { code: 'TIMEOUT', message: 'Timed out' },
    });

    expect(() => resp.raiseForStatus()).toThrow('Timed out');
  });

  it('should not throw on success', () => {
    const resp = new EvalResponse({ run_id: 'r1', output: 'ok', passed: true, scores: [] });
    expect(() => resp.raiseForStatus()).not.toThrow();
  });

  it('should getScore by name', () => {
    const resp = new EvalResponse({
      run_id: 'r1',
      scores: [
        { scorer: 'exact_match', score: 1.0, passed: true },
        { scorer: 'contains', score: 0.0, passed: false },
      ],
    });

    expect(resp.getScore('exact_match')?.passed).toBe(true);
    expect(resp.getScore('contains')?.passed).toBe(false);
    expect(resp.getScore('nonexistent')).toBeUndefined();
  });

  it('should handle camelCase keys', () => {
    const resp = new EvalResponse({
      runId: 'r1',
      traceId: 't1',
      durationMs: 100,
      output: 'ok',
      scores: [],
    });
    expect(resp.runId).toBe('r1');
    expect(resp.traceId).toBe('t1');
    expect(resp.durationMs).toBe(100);
  });
});

describe('BatchEvalItemResult', () => {
  it('should create from eval response', () => {
    const evalResp = new EvalResponse({
      run_id: 'r1',
      output: 'ok',
      duration_ms: 50,
      scores: [{ scorer: 'exact_match', score: 1.0, passed: true }],
      passed: true,
    });

    const item = BatchEvalItemResult.fromEvalResponse(evalResp, 0, 'item-1');
    expect(item.index).toBe(0);
    expect(item.itemId).toBe('item-1');
    expect(item.isSuccess).toBe(true);
    expect(item.passed).toBe(true);
  });

  it('should create from exception', () => {
    const item = BatchEvalItemResult.fromException(new Error('boom'), 2, 'item-3');
    expect(item.index).toBe(2);
    expect(item.isFailed).toBe(true);
    expect(item.isSuccess).toBe(false);
    expect(item.error).toBe('boom');
    expect(item.passed).toBe(false);
  });
});

describe('BatchEvalResult', () => {
  it('should compute stats from results', () => {
    const results = [
      new BatchEvalItemResult({ index: 0, run_id: 'r1', output: 'ok', passed: true, scores: [], duration_ms: 10 }),
      new BatchEvalItemResult({ index: 1, run_id: 'r2', output: 'ok', passed: true, scores: [], duration_ms: 20 }),
      new BatchEvalItemResult({ index: 2, run_id: 'r3', output: 'bad', passed: false, scores: [], duration_ms: 30 }),
    ];

    const batch = new BatchEvalResult({
      batchId: 'b1',
      status: 'completed',
      results,
      durationMs: 100,
    });

    expect(batch.passRate).toBeCloseTo(2 / 3);
    expect(batch.stats.totalItems).toBe(3);
    expect(batch.stats.passedItems).toBe(2);
    expect(batch.passingItems()).toHaveLength(2);
    expect(batch.failingItems()).toHaveLength(1);
    expect(batch.outputs).toEqual(['ok', 'ok', 'bad']);
  });

  it('should sort results by index', () => {
    const results = [
      new BatchEvalItemResult({ index: 2, run_id: 'r3', output: 'c', scores: [], duration_ms: 0 }),
      new BatchEvalItemResult({ index: 0, run_id: 'r1', output: 'a', scores: [], duration_ms: 0 }),
      new BatchEvalItemResult({ index: 1, run_id: 'r2', output: 'b', scores: [], duration_ms: 0 }),
    ];

    const batch = new BatchEvalResult({ batchId: 'b1', status: 'completed', results });
    expect(batch.outputs).toEqual(['a', 'b', 'c']);
  });

  it('should identify partial failures', () => {
    const results = [
      new BatchEvalItemResult({ index: 0, run_id: 'r1', output: 'ok', scores: [], duration_ms: 0 }),
      new BatchEvalItemResult({ index: 1, run_id: '', output: undefined, error: 'timeout', scores: [], duration_ms: 0 }),
    ];

    const batch = new BatchEvalResult({ batchId: 'b1', status: 'partial_failure', results });
    expect(batch.isPartialFailure).toBe(true);
    expect(batch.failedItems()).toHaveLength(1);
  });
});

describe('LLMJudge', () => {
  it('should create with defaults', () => {
    const judge = new LLMJudge({ criteria: 'Is it helpful?' });
    expect(judge.criteria).toBe('Is it helpful?');
    expect(judge.model).toBe('openai/gpt-4o-mini');
    expect(judge.temperature).toBe(0);
    expect(judge.includeInput).toBe(false);
  });

  it('should convert to scorer spec', () => {
    const judge = new LLMJudge({
      criteria: 'Is it accurate?',
      model: 'anthropic/claude-sonnet-4-6',
      includeInput: true,
      temperature: 0.5,
    });

    const spec = judge.toScorerSpec();
    expect(spec.name).toBe('llm_judge');
    expect(spec.config.criteria).toBe('Is it accurate?');
    expect(spec.config.provider).toBe('anthropic');
    expect(spec.config.model).toBe('claude-sonnet-4-6');
    expect(spec.config.include_input).toBe(true);
    expect(spec.config.temperature).toBe(0.5);
  });
});

describe('Managed judge presets', () => {
  it('should convert Correctness to scorer spec', () => {
    const judge = new Correctness({ answerField: 'output.answer' });
    const spec = judge.toScorerSpec();
    expect(spec.name).toBe('correctness');
    expect(spec.config.provider).toBe('openai');
    expect(spec.config.model).toBe('gpt-4o-mini');
    expect(spec.config.answer_field).toBe('output.answer');
  });

  it('should convert Faithfulness to scorer spec', () => {
    const judge = new Faithfulness({
      contextFields: ['input.context'],
      answerField: 'output.answer',
    });
    const spec = judge.toScorerSpec();
    expect(spec.name).toBe('faithfulness');
    expect(spec.config.context_fields).toEqual(['input.context']);
    expect(spec.config.answer_field).toBe('output.answer');
  });
});

describe('normalizeBatchEvalItems', () => {
  it('should handle BatchEvalItem objects', () => {
    const items = normalizeBatchEvalItems([
      { input: { a: 1 }, expected: 'one' },
      { input: { a: 2 }, expected: 'two' },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].input.a).toBe(1);
    expect(items[0].expected).toBe('one');
    expect(items[0].index).toBe(0);
  });

  it('should handle plain input dicts with separate expected', () => {
    const items = normalizeBatchEvalItems(
      [{ a: 1 }, { a: 2 }],
      ['one', 'two'],
    );
    expect(items[0].input.a).toBe(1);
    expect(items[0].expected).toBe('one');
    expect(items[1].expected).toBe('two');
  });
});

describe('normalizeScorerSpecs', () => {
  it('should normalize string scorers', () => {
    const specs = normalizeScorerSpecs(['exact_match', 'contains']);
    expect(specs).toEqual([{ name: 'exact_match' }, { name: 'contains' }]);
  });

  it('should normalize LLMJudge instances', () => {
    const specs = normalizeScorerSpecs([new LLMJudge({ criteria: 'test' })]);
    expect(specs[0].name).toBe('llm_judge');
    expect(specs[0].config.criteria).toBe('test');
  });

  it('should normalize managed judge preset instances', () => {
    const specs = normalizeScorerSpecs([
      new Correctness(),
      new Faithfulness({ contextFields: ['input.context'] }),
    ]);
    expect(specs[0].name).toBe('correctness');
    expect(specs[1].name).toBe('faithfulness');
  });

  it('should pass through raw specs', () => {
    const raw = { name: 'custom', config: { x: 1 } };
    const specs = normalizeScorerSpecs([raw]);
    expect(specs[0]).toBe(raw);
  });
});
