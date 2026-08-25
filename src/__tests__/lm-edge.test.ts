import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loader = vi.hoisted(() => ({ bindings: null as any }));

vi.mock('../native-loader.js', () => ({
  getLoadedNativeBindings: () => loader.bindings,
  tryLoadNativeBindings: () => loader.bindings,
  loadNativeBindings: () => {
    if (!loader.bindings) throw new TypeError("createRequire received 'undefined'");
    return loader.bindings;
  },
}));

import { LM } from '../lm.js';
import { Agent, AgentRegistry } from '../agent.js';
import { serveCloudflare } from '../workerless-cloudflare.js';

describe('LM edge fallback', () => {
  beforeEach(() => {
    loader.bindings = null;
    AgentRegistry.clear();
  });

  afterEach(() => {
    AgentRegistry.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('constructs every provider when native bindings are unavailable', () => {
    expect(() => [
      LM.openai({ apiKey: 'test' }),
      LM.anthropic({ apiKey: 'test' }),
      LM.azure({ apiKey: 'test', endpoint: 'https://example.openai.azure.com' }),
      LM.baseten({ apiKey: 'test' }),
      LM.bedrock({
        region: 'us-east-1',
        accessKeyId: 'test',
        secretAccessKey: 'test',
      }),
      LM.groq({ apiKey: 'test' }),
      LM.fireworks({ apiKey: 'test' }),
      LM.openrouter({ apiKey: 'test' }),
      LM.deepseek({ apiKey: 'test' }),
      LM.google({ apiKey: 'test' }),
      LM.mistral({ apiKey: 'test' }),
      LM.lepton({ apiKey: 'test', baseUrl: 'https://example.test/v1' }),
      LM.ollama(),
      LM.together({ apiKey: 'test' }),
      LM.xai({ apiKey: 'test' }),
      LM.moonshot({ apiKey: 'test' }),
      LM.huggingface({ apiKey: 'test' }),
      LM.openaiChat({ apiKey: 'test' }),
    ]).not.toThrow();
  });

  it('keeps a module-scope edge agent in the Cloudflare manifest', () => {
    const agent = new Agent({
      name: 'edge-agent',
      model: LM.openai({ apiKey: 'test' }),
      modelName: 'openai/gpt-4.1-mini',
      instructions: 'Be concise.',
    });

    const handler = serveCloudflare({ agents: [agent] });

    expect(handler.manifest().components).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'edge-agent', type: 'agent' }),
    ]));
  });

  it('generates through the OpenAI edge adapter', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'resp_123',
      created_at: 1_725_000_000,
      model: 'gpt-4.1-mini',
      status: 'completed',
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'Hello from the edge' }],
      }],
      usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await LM.openai({ apiKey: 'edge-key' }).generate({
      model: 'openai/gpt-4.1-mini',
      systemPrompt: 'Be concise.',
      messages: [{ role: 'user', content: 'Say hello.' }],
      tools: [{ name: 'lookup', parameters: '{"type":"object"}' }],
      config: { maxOutputTokens: 64, reasoningEffort: 'minimal' },
    });

    expect(response).toMatchObject({
      id: 'resp_123',
      model: 'gpt-4.1-mini',
      text: 'Hello from the edge',
      finishReason: 'completed',
      usage: { promptTokens: 5, completionTokens: 4, totalTokens: 9 },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer edge-key',
    });
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      model: 'gpt-4.1-mini',
      instructions: 'Be concise.',
      max_output_tokens: 64,
      reasoning: { effort: 'minimal' },
    });
  });

  it('accumulates streamed OpenAI-compatible tool-call argument deltas', async () => {
    const events = [
      { id: 'chat_123', model: 'custom-model', created: 1, choices: [{ index: 0, delta: { content: 'Checking ' } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"city"' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"Paris"}' } }] }, finish_reason: 'tool_calls' }] },
    ];
    const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })));

    const chunks: any[] = [];
    await LM.openaiChat({ apiKey: 'edge-key', baseUrl: 'https://chat.example/v1' }).stream({
      model: 'openai_chat/custom-model',
      messages: [{ role: 'user', content: 'Check Paris.' }],
    }, chunk => chunks.push(chunk));

    expect(chunks).toEqual([
      { chunkType: 'delta', content: 'Checking ' },
      {
        chunkType: 'completed',
        response: expect.objectContaining({
          id: 'chat_123',
          model: 'custom-model',
          text: 'Checking ',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call_1', name: 'lookup', arguments: '{"city":"Paris"}' }],
        }),
      },
    ]);
  });

  it('maps Anthropic messages, tools, and usage on the edge path', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'msg_123',
      model: 'claude-sonnet-4-20250514',
      content: [
        { type: 'text', text: 'I will look it up.' },
        { type: 'tool_use', id: 'tool_1', name: 'lookup', input: { city: 'Paris' } },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 6,
        output_tokens: 5,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await LM.anthropic({ apiKey: 'anthropic-key' }).generate({
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'Be concise.',
      messages: [{ role: 'user', content: 'Check Paris.' }],
      tools: [{ name: 'lookup', parameters: '{"type":"object"}' }],
      config: { cache: { ttl: '1h' } },
    });

    expect(response).toMatchObject({
      id: 'msg_123',
      text: 'I will look it up.',
      toolCalls: [{ id: 'tool_1', name: 'lookup', arguments: '{"city":"Paris"}' }],
      usage: {
        promptTokens: 6,
        completionTokens: 5,
        totalTokens: 11,
        cachedTokens: 2,
        cacheCreationTokens: 1,
      },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init as RequestInit).headers).toMatchObject({
      'x-api-key': 'anthropic-key',
      'anthropic-version': '2023-06-01',
    });
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      model: 'claude-sonnet-4-20250514',
      system: [{
        type: 'text',
        text: 'Be concise.',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      }],
    });
  });

  it('maps Gemini functions and hosted search on the edge path', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      responseId: 'gemini_123',
      modelVersion: 'gemini-2.5-flash',
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ text: 'Gemini edge response' }] },
      }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await LM.google({ apiKey: 'google-key' }).generate({
      model: 'google/gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Find this.' }],
      tools: [{ name: 'lookup', parameters: '{"type":"object"}' }],
      config: { builtInTools: ['web_search'] },
    });

    expect(response).toMatchObject({ id: 'gemini_123', text: 'Gemini edge response' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=google-key');
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      tools: [
        { functionDeclarations: [{ name: 'lookup', parameters: { type: 'object' } }] },
        { google_search: {} },
      ],
    });
  });

  it('signs Bedrock requests with an edge-safe Web Crypto implementation', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output: { message: { content: [{ text: 'Bedrock edge response' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await LM.bedrock({
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret',
    }).generate({
      model: 'bedrock/us-west-2/anthropic.claude-3-5-sonnet-20241022-v2:0',
      messages: [{ role: 'user', content: 'Hello.' }],
    });

    expect(response.text).toBe('Bedrock edge response');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/converse',
    );
    expect((init as RequestInit).headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: expect.stringContaining('Credential=AKIATEST/'),
    });
  });

  it('keeps using native bindings when they are available', async () => {
    const nativeGenerate = vi.fn(async () => ({
      id: 'native',
      model: 'openai/gpt-4.1-mini',
      text: 'native response',
    }));
    const nativeFactory = vi.fn(() => ({ generate: nativeGenerate }));
    loader.bindings = { LanguageModel: { openai: nativeFactory } };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await LM.openai({ apiKey: 'native-key' }).generate({
      model: 'openai/gpt-4.1-mini',
      messages: [],
    });

    expect(nativeFactory).toHaveBeenCalledWith({ apiKey: 'native-key' });
    expect(nativeGenerate).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.text).toBe('native response');
  });
});
