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

  it('contains: should pass when output contains expected', () => {
    const result = contains({ output: 'hello world', expected: 'world' });
    expect(result.passed).toBe(true);
  });

  it('contains: should fail when output does not contain expected', () => {
    const result = contains({ output: 'hello', expected: 'world' });
    expect(result.passed).toBe(false);
  });

  it('jsonValid: should pass for valid JSON', () => {
    const result = jsonValid({ output: '{"key": "value"}' });
    expect(result.passed).toBe(true);
  });

  it('jsonValid: should fail for invalid JSON', () => {
    const result = jsonValid({ output: 'not json' });
    expect(result.passed).toBe(false);
  });

  it('regexMatch: should match patterns', () => {
    expect(regexMatch({ output: 'abc123', expected: '\\d+' }).passed).toBe(true);
    expect(regexMatch({ output: 'abcdef', expected: '^\\d+$' }).passed).toBe(false);
  });

  it('regexMatch: should handle invalid regex gracefully', () => {
    const result = regexMatch({ output: 'test', expected: '[invalid' });
    expect(result.passed).toBe(false);
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
    expect(ScorerRegistry.get('test_scorer')).toBeDefined();
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
    expect(names).toContain('regex_match');
    expect(names).toContain('levenshtein');
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
