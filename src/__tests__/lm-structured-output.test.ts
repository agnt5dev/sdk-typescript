import { beforeEach, describe, expect, it, vi } from 'vitest';

const generate = vi.fn();

vi.mock('#native-loader', () => ({
  tryLoadNativeBindings: () => ({
    LanguageModel: {
      anthropic: () => ({ generate }),
    },
  }),
}));

describe('LM structured output', () => {
  beforeEach(() => {
    generate.mockReset();
  });

  it('parses structured JSON preserved by the native binding', async () => {
    generate.mockResolvedValue({
      id: 'response-1',
      model: 'anthropic/claude-haiku-4-5',
      text: '```json\n{"city":"Paris"}\n```',
      structuredOutput: '{"city":"Paris"}',
    });

    const { LM } = await import('../lm.js');
    const model = LM.anthropic({ apiKey: 'test-key' });
    const response = await model.generate({
      model: 'anthropic/claude-haiku-4-5',
      messages: [{ role: 'user', content: 'Return a city.' }],
    });

    expect(response.structuredOutput).toEqual({ city: 'Paris' });
  });

  it('preserves opaque non-JSON provider state', async () => {
    generate.mockResolvedValue({
      id: 'response-2',
      model: 'anthropic/claude-haiku-4-5',
      text: '',
      structuredOutput: 'not-json',
      toolCalls: [{
        id: 'call-1',
        name: 'lookup',
        arguments: '{}',
        providerData: 'opaque-provider-token',
      }],
    });

    const { LM } = await import('../lm.js');
    const model = LM.anthropic({ apiKey: 'test-key' });
    const response = await model.generate({
      model: 'anthropic/claude-haiku-4-5',
      messages: [{ role: 'user', content: 'Use a tool.' }],
    });

    expect(response.structuredOutput).toBe('not-json');
    expect(response.toolCalls?.[0]?.providerData).toBe('opaque-provider-token');
  });
});
