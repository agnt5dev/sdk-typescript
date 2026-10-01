import { describe, expect, it } from 'vitest';
import {
  claudeDefaultMaxTokens,
  claudeRejectsSamplingParams,
  rejectsSamplingParams,
} from '../providers/model-caps.js';

// Mirrors sdk-core's lm::model_caps tests (AGNT5-1403, AGNT5-1456).
describe('model caps', () => {
  it.each([
    'openai/gpt-5-mini',
    'openai/gpt-6-luna',
    'azure/gpt-6-luna',
    'o3-mini',
    'anthropic/claude-opus-4-7',
    'anthropic/claude-sonnet-5',
    'anthropic/claude-opus-5',
    'anthropic/claude-fable-5-1',
    'bedrock/us-east-1/us.anthropic.claude-opus-4-7-20260115-v1:0',
    'claude-opus-4-7@20260115',
    'anthropic/claude-newfamily-1',
  ])('%s rejects sampling parameters', (model) => {
    expect(rejectsSamplingParams(model)).toBe(true);
  });

  it.each([
    'openai/gpt-4o-mini',
    'openai/gpt-4.1',
    'groq/openai/gpt-oss-120b',
    'anthropic/claude-haiku-4-5',
    'anthropic/claude-haiku-4-5-20251001',
    'anthropic/claude-sonnet-4-6',
    'anthropic/claude-sonnet-4-20250514',
    'anthropic/claude-3-5-sonnet-20241022',
    'bedrock/us-west-2/anthropic.claude-3-5-sonnet-20241022-v2:0',
    'claude-2.1',
    'claude-instant-1.2',
  ])('%s accepts sampling parameters', (model) => {
    expect(rejectsSamplingParams(model)).toBe(false);
  });

  it('only applies the Claude rule to Claude', () => {
    expect(claudeRejectsSamplingParams('openai/gpt-6-luna')).toBe(false);
  });

  it('gives thinking models a larger default output budget', () => {
    expect(claudeDefaultMaxTokens('anthropic/claude-opus-5')).toBe(16_384);
    expect(claudeDefaultMaxTokens('anthropic/claude-haiku-4-5')).toBe(4_096);
  });
});
