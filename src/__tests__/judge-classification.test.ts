import { expect, it } from 'vitest';
import { llmJudge } from '../scorer.js';

it.each([
  [{ score: 0.95, passed: true }, 'Pass'],
  [{ score: 0.1, passed: false }, 'Fail'],
  [{ passed: true }, 'Pass'],
  [{ score: 0.95 }, 'Pass'],
  [{ label: 'Fail', score: 0.95, passed: true }, 'Fail'],
])('infers a missing Pass/Fail label from %j', async (response, label) => {
  let systemPrompt = '';
  const result = await llmJudge(
    { output: '84', config: { criteria: 'Correct?', model: 'gpt-test', choice_scores: { Fail: 0, Pass: 1 } } },
    { llmJudgeLm: { generate: async (request: any) => {
      systemPrompt = request.messages[0].content;
      return { text: JSON.stringify(response) };
    } } } as any,
  );
  expect(result.label).toBe(label);
  expect(result.score).toBe(label === 'Pass' ? 1 : 0);
  expect(systemPrompt).toContain('"label"');
  expect(systemPrompt).toContain('Pass');
  expect(systemPrompt).toContain('Fail');
});

it.each(['{}', '{"label":"Maybe"}', '{"passed":"true"}', 'not json'])('rejects unusable judge output %s', async (text) => {
  await expect(llmJudge(
    { output: '84', config: { criteria: 'Correct?', model: 'gpt-test', choice_scores: { Fail: 0, Pass: 1 } } },
    { llmJudgeLm: { generate: async () => ({ text }) } } as any,
  )).rejects.toThrow(/[Jj]udge/);
});

it('surfaces classification model failures', async () => {
  await expect(llmJudge(
    { output: '84', config: { criteria: 'Correct?', model: 'gpt-test', choice_scores: { Fail: 0, Pass: 1 } } },
    { llmJudgeLm: { generate: async () => { throw new Error('provider unavailable'); } } } as any,
  )).rejects.toThrow('provider unavailable');
});

it.each([[0.8, 'Good'], [0.6, 'Partial'], [0.75, undefined]])('uses a unique nearest score for multiclass output %s', async (score, label) => {
  const result = llmJudge(
    { output: '84', config: { criteria: 'Quality?', model: 'gpt-test', choice_scores: { Bad: 0, Partial: 0.5, Good: 1 } } },
    { llmJudgeLm: { generate: async () => ({ text: JSON.stringify({ score }) }) } } as any,
  );
  if (label === undefined) await expect(result).rejects.toThrow('Judge');
  else expect((await result).label).toBe(label);
});
