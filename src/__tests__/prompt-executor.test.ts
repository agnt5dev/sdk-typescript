import { describe, expect, it } from 'vitest';
import {
  executePromptWorkerInput,
  isPromptExecutorComponent,
  normalizePromptModel,
  PROMPT_EXECUTOR_COMPONENT_NAME,
  PROMPT_WORKER_INPUT_SCHEMA_VERSION,
  type PromptWorkerInput,
} from '../prompt-executor.js';

function promptPayload(overrides: Partial<PromptWorkerInput> = {}): PromptWorkerInput {
  return {
    schema_version: PROMPT_WORKER_INPUT_SCHEMA_VERSION,
    input: { limit: 2, user: { name: 'Arun' } },
    variables: { limit: 2, user: { name: 'Arun' } },
    prompt: {
      model: 'gpt-5-mini',
      parameters: {
        temperature: 0.2,
        max_tokens: 50,
        top_p: 0.9,
      },
      messages: [
        { role: 'system', content: 'Return JSON only.' },
        { role: 'user', content: 'Fetch {{limit}} ids for {{user.name}}.' },
      ],
      response_format: 'text',
    },
    ...overrides,
  };
}

describe('prompt executor', () => {
  it('renders variables and parses JSON output', async () => {
    const calls: any[] = [];
    const result = await executePromptWorkerInput(promptPayload(), async (request) => {
      calls.push(request);
      return { id: 'resp_1', model: request.model, text: '[48138136,48140730]' };
    });

    expect(result).toEqual([48138136, 48140730]);
    expect(calls).toEqual([
      {
        model: 'openai/gpt-5-mini',
        messages: [
          { role: 'system', content: 'Return JSON only.' },
          { role: 'user', content: 'Fetch 2 ids for Arun.' },
        ],
        temperature: 0.2,
        maxTokens: 50,
        topP: 0.9,
        responseFormat: undefined,
      },
    ]);
  });

  it('passes JSON schema response format', async () => {
    const responseSchema = {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'integer' } } },
      required: ['ids'],
    };
    const calls: any[] = [];

    const result = await executePromptWorkerInput(
      promptPayload({
        prompt: {
          model: 'openai/gpt-5-mini',
          messages: [{ role: 'user', content: 'Return ids' }],
          response_format: 'json_schema',
          response_schema: responseSchema,
        },
      }),
      async (request) => {
        calls.push(request);
        return { id: 'resp_1', model: request.model, text: '{"ids":[48138136]}' };
      },
    );

    expect(result).toEqual({ ids: [48138136] });
    expect(calls[0].responseFormat).toEqual({
      formatType: 'json_schema',
      schemaName: 'agnt5_prompt_output',
      schema: JSON.stringify(responseSchema),
      strict: true,
    });
  });

  it.each([
    ['gpt-5-mini', 'openai/gpt-5-mini'],
    ['o3-mini', 'openai/o3-mini'],
    ['claude-3-5-sonnet-latest', 'anthropic/claude-3-5-sonnet-latest'],
    ['gemini-1.5-pro', 'google/gemini-1.5-pro'],
    [
      'openrouter/meta-llama/llama-3.1-70b-instruct',
      'openrouter/meta-llama/llama-3.1-70b-instruct',
    ],
  ])('normalizes %s to %s', (model, expected) => {
    expect(normalizePromptModel(model)).toBe(expected);
  });

  it('rejects unknown schema versions', async () => {
    await expect(
      executePromptWorkerInput(
        promptPayload({ schema_version: 'agnt5.eval.prompt_worker_input.v0' }),
        async () => 'never called',
      ),
    ).rejects.toThrow('Unsupported prompt executor input schema');
  });

  it('recognizes prompt executor aliases', () => {
    expect(isPromptExecutorComponent(PROMPT_EXECUTOR_COMPONENT_NAME)).toBe(true);
    expect(isPromptExecutorComponent('run_prompt')).toBe(true);
    expect(isPromptExecutorComponent('ordinary_user_function')).toBe(false);
  });
});
