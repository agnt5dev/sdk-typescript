import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { structuredAssertions, ScorerRegistry, runScorer } from '../scorer.js';

const cases = JSON.parse(readFileSync(new URL('../../test-fixtures/eval/structured_assertions.json', import.meta.url), 'utf8')).cases;
describe('SDK-core structured assertion contract', () => {
  for (const c of cases) it(c.name, () => {
    const result = structuredAssertions(c.input);
    expect(result.score).toBe(c.expect.score);
    expect(result.passed).toBe(c.expect.passed);
    expect(result.label).toBe(c.expect.label);
  });
  it('intercepts builtins without user registration', async () => {
    expect(ScorerRegistry.get('structured_assertions')).toBeDefined();
    const result = await runScorer('structured_assertions', { output: [1, 2], config: { assertions: [{ expr: 'unique(output)' }] } });
    expect(result.passed).toBe(true);
    expect(result.metadata?.assertions[0].passed).toBe(true);
  });
});
