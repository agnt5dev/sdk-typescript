import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../errors.js';
import { parseModelIdentifier, validateModelForProvider } from '../lm.js';

describe('LM model validation', () => {
  it('rejects unsupported provider prefixes', () => {
    expect(() => parseModelIdentifier('open/gpt-5-mini')).toThrow(ConfigurationError);
    expect(() => parseModelIdentifier('open/gpt-5-mini')).toThrow(
      "Unsupported model provider 'open'",
    );
  });

  it('rejects missing provider prefixes', () => {
    expect(() => parseModelIdentifier('gpt-5-mini')).toThrow(
      'Model must include provider prefix',
    );
  });

  it('rejects missing model names', () => {
    expect(() => parseModelIdentifier('openai/')).toThrow(
      'both provider and model name',
    );
  });

  it('rejects provider/model mismatch for concrete providers', () => {
    expect(() => validateModelForProvider('open/gpt-5-mini', 'openai')).toThrow(
      "Unsupported model provider 'open'",
    );
    expect(() => validateModelForProvider('anthropic/claude-3-5-haiku', 'openai')).toThrow(
      "Provider 'openai' does not match model prefix 'anthropic'",
    );
  });

  it('allows gateway providers to use arbitrary model prefixes', () => {
    expect(validateModelForProvider('meta-llama/llama-3.1-8b-instruct', 'openrouter')).toBe(
      'meta-llama/llama-3.1-8b-instruct',
    );
  });
});
