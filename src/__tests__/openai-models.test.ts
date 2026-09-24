import { describe, expect, it } from 'vitest';
import { isOpenAIReasoningModel } from '../providers/openai-models.js';

describe('isOpenAIReasoningModel', () => {
  it('matches the gpt-5 and gpt-6 families and the o-series, with or without the provider prefix', () => {
    for (const model of ['gpt-5', 'gpt-5-mini', 'gpt-6', 'gpt-6-luna', 'openai/gpt-6-luna', 'o1', 'o1-preview', 'o3-mini', 'o4-mini', 'GPT-6-Luna']) {
      expect(isOpenAIReasoningModel(model), model).toBe(true);
    }
  });

  it('leaves the classic models alone', () => {
    for (const model of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-3.5-turbo', 'o1x', 'openai/gpt-4.1-mini']) {
      expect(isOpenAIReasoningModel(model), model).toBe(false);
    }
  });
});
