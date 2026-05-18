import { describe, it, expect, beforeEach } from 'vitest';
import {
  ScorerResult,
  ScorerRegistry,
  scorer,
  isScorer,
  getScorerConfig,
  runScorer,
  exactMatch,
  contains,
  jsonValid,
  jsonSchema,
  llmJudge,
  correctness,
  faithfulness,
  numericRange,
  regexMatch,
  levenshtein,
  getTotalTokens,
} from '../scorer.js';
import type { ScorerRequest } from '../scorer.js';

describe('ScorerResult', () => {
  it('should clamp score between 0 and 1', () => {
    expect(new ScorerResult({ score: 1.5 }).score).toBe(1.0);
    expect(new ScorerResult({ score: -0.5 }).score).toBe(0.0);
  });

  it('should default passed to score >= 0.5', () => {
    expect(new ScorerResult({ score: 0.7 }).passed).toBe(true);
    expect(new ScorerResult({ score: 0.3 }).passed).toBe(false);
    expect(new ScorerResult({ score: 0.5 }).passed).toBe(true);
  });

  it('should allow explicit passed override', () => {
    expect(new ScorerResult({ score: 0.8, passed: false }).passed).toBe(false);
    expect(new ScorerResult({ score: 0.2, passed: true }).passed).toBe(true);
  });

  it('should create pass/fail results', () => {
    const pass = ScorerResult.pass('good');
    expect(pass.score).toBe(1.0);
    expect(pass.passed).toBe(true);
    expect(pass.explanation).toBe('good');

    const fail = ScorerResult.fail('bad');
    expect(fail.score).toBe(0.0);
    expect(fail.passed).toBe(false);
    expect(fail.explanation).toBe('bad');
  });
});

describe('Built-in scorers', () => {
  it('exactMatch: should pass on exact match', () => {
    const result = exactMatch({ output: 'hello', expected: 'hello' });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
  });

  it('exactMatch: should fail on mismatch', () => {
    const result = exactMatch({ output: 'hello', expected: 'world' });
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.0);
  });

  it('contains: should pass when output contains config.pattern', () => {
    const result = contains({ output: 'hello world', config: { pattern: 'world' } });
    expect(result.passed).toBe(true);
  });

  it('contains: should fail when output does not contain config.pattern', () => {
    const result = contains({ output: 'hello', config: { pattern: 'world' } });
    expect(result.passed).toBe(false);
  });

  it('contains: should honor case_sensitive=false', () => {
    const result = contains({
      output: 'Hello World',
      config: { pattern: 'WORLD', case_sensitive: false },
    });
    expect(result.passed).toBe(true);
  });

  it('contains: legacy expected-field still works as a fallback', () => {
    // Back-compat path until callers migrate. Will be removed once
    // external usage moves to config.pattern.
    const result = contains({ output: 'hello world', expected: 'world' });
    expect(result.passed).toBe(true);
  });

  it('jsonValid: should pass for valid JSON', () => {
    const result = jsonValid({ output: '{"key": "value"}' });
    expect(result.passed).toBe(true);
  });

  it('jsonValid: should fail for invalid JSON', () => {
    const result = jsonValid({ output: 'not json' });
    expect(result.passed).toBe(false);
  });

  it('jsonValid: structured object is already valid (matches Rust)', () => {
    expect(jsonValid({ output: { k: 'v' } }).passed).toBe(true);
    expect(jsonValid({ output: [1, 2, 3] }).passed).toBe(true);
    expect(jsonValid({ output: 42 }).passed).toBe(true);
    expect(jsonValid({ output: null }).passed).toBe(true);
  });

  it('regexMatch: should match patterns from config.pattern', () => {
    expect(
      regexMatch({ output: 'abc123', config: { pattern: '\\d+' } }).passed,
    ).toBe(true);
    expect(
      regexMatch({ output: 'abcdef', config: { pattern: '^\\d+$' } }).passed,
    ).toBe(false);
  });

  it('regexMatch: should handle invalid regex gracefully', () => {
    const result = regexMatch({ output: 'test', config: { pattern: '[invalid' } });
    expect(result.passed).toBe(false);
  });

  it('regexMatch: legacy expected-field still works as a fallback', () => {
    const result = regexMatch({ output: 'abc123', expected: '\\d+' });
    expect(result.passed).toBe(true);
  });

  it('levenshtein: should return 1.0 for exact match', () => {
    const result = levenshtein({ output: 'hello', expected: 'hello' });
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it('levenshtein: should return high score for similar strings', () => {
    const result = levenshtein({ output: 'hello', expected: 'helo' });
    expect(result.score).toBeGreaterThan(0.7);
    expect(result.passed).toBe(true);
  });

  it('levenshtein: should return low score for very different strings', () => {
    const result = levenshtein({ output: 'abcdef', expected: 'xyz' });
    expect(result.score).toBeLessThan(0.5);
    expect(result.passed).toBe(false);
  });

  // ─── json_schema ───────────────────────────────────────────────────
  it('jsonSchema: should pass for valid object', () => {
    const result = jsonSchema({
      output: { name: 'Ada' },
      config: {
        schema: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
      },
    });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
    expect(result.label).toBe('valid');
  });

  it('jsonSchema: should fail for invalid object with errors', () => {
    const result = jsonSchema({
      output: { name: 'Ada', age: -1 },
      config: {
        schema: {
          type: 'object',
          required: ['name', 'age'],
          properties: {
            name: { type: 'string' },
            age: { type: 'integer', minimum: 0 },
          },
        },
      },
    });
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.0);
    expect(result.label).toBe('invalid');
    const errors = (result.metadata?.errors ?? []) as string[];
    expect(errors.length).toBeGreaterThan(0);
  });

  it('jsonSchema: should parse string output as JSON', () => {
    const result = jsonSchema({
      output: '[1, 2, 3]',
      config: { schema: { type: 'array', items: { type: 'integer' } } },
    });
    expect(result.passed).toBe(true);
  });

  it('jsonSchema: should label parse_error for unparseable string', () => {
    const result = jsonSchema({
      output: '{not json',
      config: { schema: { type: 'object' } },
    });
    expect(result.passed).toBe(false);
    expect(result.label).toBe('parse_error');
  });

  it('jsonSchema: should label config_error for missing schema', () => {
    const result = jsonSchema({ output: { x: 1 } });
    expect(result.label).toBe('config_error');
  });

  // ─── numeric_range ─────────────────────────────────────────────────
  it('numericRange: should pass for value in [min, max] inclusive', () => {
    expect(numericRange({ output: 5, config: { min: 1, max: 10 } }).passed).toBe(true);
    expect(numericRange({ output: 1, config: { min: 1, max: 10 } }).passed).toBe(true);
    expect(numericRange({ output: 10, config: { min: 1, max: 10 } }).passed).toBe(true);
  });

  it('numericRange: should fail boundary values when exclusive', () => {
    expect(
      numericRange({ output: 10, config: { min: 1, max: 10, inclusive: false } }).passed,
    ).toBe(false);
    expect(
      numericRange({ output: 1, config: { min: 1, max: 10, inclusive: false } }).passed,
    ).toBe(false);
    expect(
      numericRange({ output: 5, config: { min: 1, max: 10, inclusive: false } }).passed,
    ).toBe(true);
  });

  it('numericRange: should fail out-of-range', () => {
    const below = numericRange({ output: 0, config: { min: 1, max: 10 } });
    expect(below.passed).toBe(false);
    expect(below.label).toBe('out_of_range');
    const above = numericRange({ output: 11, config: { min: 1, max: 10 } });
    expect(above.passed).toBe(false);
  });

  it('numericRange: should accept one-sided bounds', () => {
    expect(numericRange({ output: 100, config: { min: 50 } }).passed).toBe(true);
    expect(numericRange({ output: 49, config: { min: 50 } }).passed).toBe(false);
    expect(numericRange({ output: 0.4, config: { max: 0.5 } }).passed).toBe(true);
    expect(numericRange({ output: 0.6, config: { max: 0.5 } }).passed).toBe(false);
  });

  it('numericRange: should parse numeric strings', () => {
    expect(numericRange({ output: '3.14', config: { min: 0, max: 5 } }).passed).toBe(true);
  });

  it('numericRange: should label parse_error for non-numeric output', () => {
    const r = numericRange({ output: 'not a number', config: { min: 0, max: 5 } });
    expect(r.passed).toBe(false);
    expect(r.label).toBe('parse_error');
  });

  it('numericRange: should label config_error when neither bound is set', () => {
    const r = numericRange({ output: 1, config: {} });
    expect(r.label).toBe('config_error');
  });

  // ─── llm_judge ─────────────────────────────────────────────────────
  // The judge needs an LM. Tests inject a stub via the ScorerContext
  // (`ctx.llmJudgeLm`) so we don't depend on real provider credentials.
  it('llmJudge: should parse a valid JSON judge response', async () => {
    const stubLm = {
      generate: async () => ({
        text: '{"score": 0.9, "passed": true, "explanation": "Looks correct"}',
      }),
    };
    const result = await llmJudge(
      {
        output: 'The capital of France is Paris.',
        config: { criteria: 'Factually correct?', provider: 'openai', model: 'gpt-4o-mini' },
      },
      { runId: 'r', correlationId: 'c', attempt: 0, log: () => {}, llmJudgeLm: stubLm } as any,
    );
    expect(result.score).toBe(0.9);
    expect(result.passed).toBe(true);
    expect(result.explanation).toBe('Looks correct');
  });

  it('llmJudge: should extract JSON from markdown-fenced response', async () => {
    const stubLm = {
      generate: async () => ({
        text: '```json\n{"score": 0.5, "explanation": "Mediocre"}\n```',
      }),
    };
    const result = await llmJudge(
      {
        output: 'whatever',
        config: { criteria: 'Anything?', provider: 'openai', model: 'gpt-4o-mini' },
      },
      { runId: 'r', correlationId: 'c', attempt: 0, log: () => {}, llmJudgeLm: stubLm } as any,
    );
    expect(result.score).toBe(0.5);
    // 0.5 < default pass threshold (0.7) and no explicit `passed` → false.
    expect(result.passed).toBe(false);
  });

  it('llmJudge: should clamp score to [0, 1]', async () => {
    const stubLm = {
      generate: async () => ({ text: '{"score": 1.5, "passed": true}' }),
    };
    const result = await llmJudge(
      {
        output: 'x',
        config: { criteria: 'c', provider: 'openai', model: 'gpt-4o-mini' },
      },
      { runId: 'r', correlationId: 'c', attempt: 0, log: () => {}, llmJudgeLm: stubLm } as any,
    );
    expect(result.score).toBe(1.0);
  });

  it('llmJudge: should infer passed from score when LLM omits it', async () => {
    const stubLm = {
      generate: async () => ({ text: '{"score": 0.8}' }),
    };
    const result = await llmJudge(
      {
        output: 'x',
        config: { criteria: 'c', provider: 'openai', model: 'gpt-4o-mini' },
      },
      { runId: 'r', correlationId: 'c', attempt: 0, log: () => {}, llmJudgeLm: stubLm } as any,
    );
    expect(result.passed).toBe(true); // 0.8 >= 0.7 default threshold
  });

  it('llmJudge: should label parse_error on invalid JSON', async () => {
    const stubLm = {
      generate: async () => ({ text: 'not json' }),
    };
    const result = await llmJudge(
      {
        output: 'x',
        config: { criteria: 'c', provider: 'openai', model: 'gpt-4o-mini' },
      },
      { runId: 'r', correlationId: 'c', attempt: 0, log: () => {}, llmJudgeLm: stubLm } as any,
    );
    expect(result.score).toBe(0.0);
    expect(result.label).toBe('parse_error');
    expect(result.metadata?.raw_response).toBe('not json');
  });

  it('llmJudge: should label error when LM throws', async () => {
    const stubLm = {
      generate: async () => {
        throw new Error('rate limited');
      },
    };
    const result = await llmJudge(
      {
        output: 'x',
        config: { criteria: 'c', provider: 'openai', model: 'gpt-4o-mini' },
      },
      { runId: 'r', correlationId: 'c', attempt: 0, log: () => {}, llmJudgeLm: stubLm } as any,
    );
    expect(result.score).toBe(0.0);
    expect(result.label).toBe('error');
    expect(result.explanation).toContain('rate limited');
  });

  it('llmJudge: should label config_error when criteria missing', async () => {
    const result = await llmJudge({
      output: 'x',
      config: { provider: 'openai', model: 'gpt-4o-mini' },
    });
    expect(result.label).toBe('config_error');
  });

  it('llmJudge: should label config_error when model missing', async () => {
    const result = await llmJudge({
      output: 'x',
      config: { criteria: 'c', provider: 'openai' },
    });
    expect(result.label).toBe('config_error');
  });

  it('llmJudge: should render custom prompt templates and map choice labels to scores', async () => {
    let prompt = '';
    const result = await llmJudge(
      {
        output: { answer: '4' },
        expected: { answer: '4' },
        input: { question: '2+2?' },
        config: {
          prompt_template:
            'Question: {{input.question}}\nAnswer: {{output.answer}}\nReference: {{expected.answer}}',
          choice_scores: { correct: 1, incorrect: 0 },
          provider: 'openai',
          model: 'gpt-test',
        },
      },
      {
        runId: 'r',
        correlationId: 'c',
        attempt: 0,
        log: () => {},
        llmJudgeLm: {
          generate: async (req: any) => {
            prompt = req.messages[1].content;
            return { text: '{"label":"correct","explanation":"matches"}' };
          },
        },
      } as any,
    );

    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
    expect(result.label).toBe('correct');
    expect(result.metadata?.selected_label).toBe('correct');
    expect(prompt).toContain('Question: 2+2?');
    expect(prompt).toContain('Choose exactly one label from: correct, incorrect');
  });

  it('llmJudge: should reject labels outside configured choice scores', async () => {
    const result = await llmJudge(
      {
        output: '4',
        config: {
          prompt_template: 'Score {{output}}',
          choice_scores: { correct: 1, incorrect: 0 },
          provider: 'openai',
          model: 'gpt-test',
        },
      },
      {
        runId: 'r',
        correlationId: 'c',
        attempt: 0,
        log: () => {},
        llmJudgeLm: {
          generate: async () => ({ text: '{"label":"maybe","explanation":"uncertain"}' }),
        },
      } as any,
    );

    expect(result.passed).toBe(false);
    expect(result.label).toBe('invalid_label');
    expect(result.metadata?.invalid_label).toBe('maybe');
    expect(result.metadata?.allowed_labels).toEqual(['correct', 'incorrect']);
  });

  it('llmJudge: should report missing custom prompt template variables', async () => {
    const result = await llmJudge({
      output: { answer: '4' },
      config: {
        prompt_template: 'Score {{output.missing}}',
        choice_scores: { correct: 1, incorrect: 0 },
        provider: 'openai',
        model: 'gpt-test',
      },
    });

    expect(result.passed).toBe(false);
    expect(result.label).toBe('config_error');
    expect(result.explanation).toContain('output.missing');
  });

  it('faithfulness: should bind configured context fields', async () => {
    let prompt = '';
    const result = await faithfulness(
      {
        output: { answer: 'Paris is the capital of France.' },
        input: { context: 'France capital: Paris.' },
        config: {
          context_fields: ['input.context'],
          answer_field: 'output.answer',
          model: 'gpt-test',
        },
      },
      {
        runId: 'run-1',
        correlationId: 'corr-1',
        attempt: 0,
        log: () => {},
        llmJudgeLm: {
          generate: async (req: any) => {
            prompt = req.messages[1].content;
            return { text: '{"score":0.9,"passed":true,"explanation":"grounded","label":"pass"}' };
          },
        },
      } as any,
    );

    expect(result.passed).toBe(true);
    expect(result.explanation).toBe('grounded');
    expect(result.metadata?.judge_preset).toBe('faithfulness');
    expect(result.metadata?.context_fields).toEqual(['input.context']);
    expect(prompt).toContain('## Context');
    expect(prompt).toContain('France capital: Paris.');
  });

  it('faithfulness: should report missing configured context fields', async () => {
    const result = await faithfulness({
      output: { answer: 'Paris' },
      input: { other: 'context' },
      config: { context_fields: ['input.context'], model: 'gpt-test' },
    });

    expect(result.passed).toBe(false);
    expect(result.label).toBe('config_error');
    expect(result.explanation).toContain('input.context');
  });

  it('correctness: should use the managed preset and preserve metadata', async () => {
    const result = await correctness(
      {
        output: { answer: '4' },
        expected: { answer: '4' },
        config: {
          answer_field: 'output.answer',
          reference_field: 'expected.answer',
          model: 'gpt-test',
        },
      },
      {
        runId: 'run-1',
        correlationId: 'corr-1',
        attempt: 0,
        log: () => {},
        llmJudgeLm: {
          generate: async () => ({ text: '{"score":1,"passed":true,"explanation":"correct"}' }),
        },
      } as any,
    );

    expect(result.passed).toBe(true);
    expect(result.metadata?.judge_preset).toBe('correctness');
  });
});

describe('Scorer decorator & registry', () => {
  it('should register scorer via decorator', () => {
    const myScorer = scorer('test_scorer', 'A test scorer')(
      (_ctx, request) => {
        return new ScorerResult({ score: request.output === 'ok' ? 1.0 : 0.0 });
      }
    );

    expect(isScorer(myScorer)).toBe(true);
    expect(getScorerConfig(myScorer)?.name).toBe('test_scorer');
    expect(getScorerConfig(myScorer)?.scope).toBe('item');
    expect(ScorerRegistry.get('test_scorer')).toBeDefined();
  });

  it('should register scorer scope metadata', () => {
    const myScorer = scorer('run_test_scorer', 'A run scorer', 'run')(
      (_ctx, request) => {
        return new ScorerResult({ score: request.output ? 1.0 : 0.0 });
      }
    );

    expect(getScorerConfig(myScorer)?.scope).toBe('run');
    expect(ScorerRegistry.get('run_test_scorer')?.scope).toBe('run');
  });

  it('should run scorer by name', async () => {
    const result = await runScorer('exact_match', { output: 'hello', expected: 'hello' });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
  });

  it('should throw for unknown scorer', async () => {
    await expect(runScorer('nonexistent', { output: '' })).rejects.toThrow("Scorer 'nonexistent' not found");
  });

  it('should list built-in scorers', () => {
    const names = ScorerRegistry.listNames();
    expect(names).toContain('exact_match');
    expect(names).toContain('contains');
    expect(names).toContain('json_valid');
    expect(names).toContain('json_schema');
    expect(names).toContain('numeric_range');
    expect(names).toContain('regex_match');
    expect(names).toContain('levenshtein');
    expect(names).toContain('llm_judge');
    expect(names).toContain('correctness');
    expect(names).toContain('faithfulness');
  });
});

describe('Trace helpers', () => {
  it('getTotalTokens should sum LM call tokens', () => {
    const request: ScorerRequest = {
      output: 'test',
      trace: [
        { eventType: 'lm.call.completed', eventId: '1', correlationId: 'c1', timestampNs: 0, data: { total_tokens: 100 } },
        { eventType: 'lm.call.completed', eventId: '2', correlationId: 'c2', timestampNs: 0, data: { total_tokens: 50 } },
        { eventType: 'other.event', eventId: '3', correlationId: 'c3', timestampNs: 0, data: { total_tokens: 999 } },
      ],
    };
    expect(getTotalTokens(request)).toBe(150);
  });
});
