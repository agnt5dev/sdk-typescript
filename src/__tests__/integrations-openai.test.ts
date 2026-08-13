import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { Completions } from 'openai/resources/chat/completions';
import { Embeddings } from 'openai/resources/embeddings';
import { Responses } from 'openai/resources/responses/responses';
import { runWithContext } from '../async-context.js';
import { disableOpenAICapture, enableOpenAICapture } from '../integrations/openai.js';

let originalCreate: any;
let providerCreate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  delete process.env.AGNT5_CAPTURE;
  delete process.env.AGNT5_CAPTURE_OPENAI;
  disableOpenAICapture();
  originalCreate = Completions.prototype.create;
  providerCreate = vi.fn();
  Completions.prototype.create = providerCreate as any;
});

afterEach(() => {
  disableOpenAICapture();
  Completions.prototype.create = originalCreate;
  delete process.env.AGNT5_CAPTURE_OPENAI;
});

describe('OpenAI capture', () => {
  it('emits started/completed with string metadata and a snapped parent', async () => {
    providerCreate.mockResolvedValue({
      model: 'gpt-4o-mini',
      choices: [{ finish_reason: 'stop', message: { content: 'pong', tool_calls: [] } }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 2,
        total_tokens: 7,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    });
    const ctx = fakeContext('fn-parent');
    await enableOpenAICapture();

    const response = await runWithContext(
      { runId: 'run-1', executionContext: ctx as any },
      () => (Completions.prototype.create as any).call({}, {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    );

    expect(response.choices[0].message.content).toBe('pong');
    const [started, completed] = capturedEvents(ctx);
    expect(started.eventType).toBe('lm.started');
    expect(started.parentCorrelationId).toBe('fn-parent');
    expect(completed.eventType).toBe('lm.completed');
    expect(completed.correlationId).toBe(started.correlationId);
    expect(completed.metadata).toMatchObject({
      model: 'openai/gpt-4o-mini',
      provider: 'openai',
      input_tokens: '5',
      output_tokens: '2',
      total_tokens: '7',
      cached_tokens: '3',
      capture_mode: 'observed',
      source: 'openai',
    });
    expect(Object.values(completed.metadata).every((value) => typeof value === 'string')).toBe(true);
  });

  it('accumulates streaming output and usage on exhaustion', async () => {
    providerCreate.mockResolvedValue(stream([
      { model: 'gpt-4o-mini', choices: [{ delta: { content: 'po' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'ng' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
    ]));
    const ctx = fakeContext('fn-stream');
    await enableOpenAICapture();

    const captured = await runWithContext(
      { runId: 'run-stream', executionContext: ctx as any },
      async () => {
        const result = await (Completions.prototype.create as any).call({}, {
          model: 'gpt-4o-mini', messages: [], stream: true,
        });
        const chunks: any[] = [];
        for await (const chunk of result) chunks.push(chunk);
        return chunks;
      },
    );

    expect(captured).toHaveLength(3);
    const completed = capturedEvents(ctx).at(-1);
    expect(completed.eventType).toBe('lm.completed');
    expect(completed.outputData.output).toBe('pong');
    expect(completed.metadata.total_tokens).toBe('3');
  });

  it('emits lm.failed and preserves the provider error', async () => {
    providerCreate.mockRejectedValue(new TypeError('provider exploded'));
    const ctx = fakeContext('fn-error');
    await enableOpenAICapture();

    await expect(runWithContext(
      { runId: 'run-error', executionContext: ctx as any },
      () => (Completions.prototype.create as any).call({}, { model: 'gpt-4o-mini', messages: [] }),
    )).rejects.toThrow('provider exploded');

    expect(capturedEvents(ctx).map((event) => event.eventType)).toEqual(['lm.started', 'lm.failed']);
    expect(capturedEvents(ctx)[1].metadata.duration_ms).toMatch(/^\d+$/);
  });

  it('emits lm.failed when an OpenAI APIPromise rejects before response parsing', async () => {
    disableOpenAICapture();
    Completions.prototype.create = originalCreate;
    const client = new OpenAI({
      apiKey: 'test-provider-key',
      maxRetries: 0,
      fetch: vi.fn(async () => new Response(
        JSON.stringify({ error: { message: 'model not found', type: 'invalid_request_error' } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      )) as any,
    });
    const ctx = fakeContext('fn-api-promise-error');
    await enableOpenAICapture();

    await expect(runWithContext(
      { runId: 'run-api-promise-error', executionContext: ctx as any },
      () => client.chat.completions.create({ model: 'missing-model', messages: [] }),
    )).rejects.toThrow('model not found');

    expect(capturedEvents(ctx).map((event) => event.eventType)).toEqual(['lm.started', 'lm.failed']);
  });

  it('passes through without context and emits nothing', async () => {
    providerCreate.mockResolvedValue({ model: 'gpt-4o-mini', choices: [], usage: {} });
    await enableOpenAICapture();
    await (Completions.prototype.create as any).call({}, { model: 'gpt-4o-mini', messages: [] });
    expect(providerCreate).toHaveBeenCalledOnce();
  });

  it('is idempotent when enabled twice', async () => {
    providerCreate.mockResolvedValue({ model: 'gpt-4o-mini', choices: [], usage: {} });
    await enableOpenAICapture();
    const wrapped = Completions.prototype.create;
    await enableOpenAICapture();
    expect(Completions.prototype.create).toBe(wrapped);
  });

  it('captures the Responses and Embeddings resource surfaces', async () => {
    const originalResponses = Responses.prototype.create;
    const originalEmbeddings = Embeddings.prototype.create;
    const createResponse = vi.fn(async () => ({
      model: 'gpt-4o-mini',
      status: 'completed',
      output_text: 'pong',
      output: [],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    }));
    const createEmbedding = vi.fn(async () => ({
      model: 'text-embedding-3-small',
      data: [{ embedding: [0.1] }],
      usage: { prompt_tokens: 2, total_tokens: 2 },
    }));
    Responses.prototype.create = createResponse as any;
    Embeddings.prototype.create = createEmbedding as any;
    try {
      const ctx = fakeContext('fn-surfaces');
      await enableOpenAICapture();
      await runWithContext({ runId: 'run-surfaces', executionContext: ctx as any }, async () => {
        await (Responses.prototype.create as any).call({}, { model: 'gpt-4o-mini', input: 'ping' });
        await (Embeddings.prototype.create as any).call({}, { model: 'text-embedding-3-small', input: 'ping' });
      });
      expect(capturedEvents(ctx).map((event) => event.eventType)).toEqual([
        'lm.started', 'lm.completed', 'lm.started', 'lm.completed',
      ]);
      expect(capturedEvents(ctx)[3].metadata.model).toBe('openai/text-embedding-3-small');
    } finally {
      disableOpenAICapture();
      Responses.prototype.create = originalResponses;
      Embeddings.prototype.create = originalEmbeddings;
    }
  });

  it('journals a failed Responses status without changing the returned object', async () => {
    const originalResponses = Responses.prototype.create;
    const failed = { status: 'failed', error: { message: 'response rejected' }, usage: {} };
    Responses.prototype.create = vi.fn(async () => failed) as any;
    try {
      const ctx = fakeContext('fn-response-failed');
      await enableOpenAICapture();
      const result = await runWithContext(
        { runId: 'run-response-failed', executionContext: ctx as any },
        () => (Responses.prototype.create as any).call({}, { model: 'gpt-4o-mini', input: 'ping' }),
      );
      expect(result).toBe(failed);
      expect(capturedEvents(ctx).map((event) => event.eventType)).toEqual(['lm.started', 'lm.failed']);
    } finally {
      disableOpenAICapture();
      Responses.prototype.create = originalResponses;
    }
  });

  it('honors the per-library kill switch', async () => {
    process.env.AGNT5_CAPTURE_OPENAI = 'off';
    expect(await enableOpenAICapture()).toBe(false);
    expect(Completions.prototype.create).toBe(providerCreate);
  });
});

function fakeContext(parent: string) {
  return {
    runId: `run-${parent}`,
    emit: vi.fn(async () => undefined),
    getCurrentCorrelationId: vi.fn(() => parent),
  };
}

function capturedEvents(ctx: ReturnType<typeof fakeContext>): any[] {
  return ctx.emit.mock.calls.map(([event]) => event);
}

function stream(chunks: any[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}
