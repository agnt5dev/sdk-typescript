import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWithContext } from '../async-context.js';
import {
  disableVercelAICapture,
  enableVercelAICapture,
  JournalSpanProcessor,
  journalTelemetry,
  wrapAISDK,
} from '../integrations/vercel-ai.js';

beforeEach(() => {
  delete process.env.AGNT5_CAPTURE;
  delete process.env.AGNT5_CAPTURE_VERCEL_AI;
});

afterEach(() => {
  disableVercelAICapture();
  delete process.env.AGNT5_CAPTURE_VERCEL_AI;
});

describe('Vercel AI SDK capture', () => {
  it('translates AI SDK telemetry model callbacks', async () => {
    const ctx = fakeContext('fn-parent');
    wrapAISDK({ generateText: vi.fn() }); // explicitly activates the integration
    await runWithContext({ runId: 'run-1', executionContext: ctx as any }, () =>
      journalTelemetry.onLanguageModelCallStart({
        callId: 'call-1',
        provider: 'openai.responses',
        modelId: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'ping' }],
        tools: [],
        maxOutputTokens: 32,
      }),
    );
    await journalTelemetry.onLanguageModelCallEnd({
      callId: 'call-1',
      provider: 'openai.responses',
      modelId: 'gpt-4o-mini',
      finishReason: 'stop',
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
        inputTokenDetails: { cacheReadTokens: 3 },
      },
      content: [{ type: 'text', text: 'pong' }],
    });

    const [started, completed] = capturedEvents(ctx);
    expect(started.eventType).toBe('lm.started');
    expect(started.parentCorrelationId).toBe('fn-parent');
    expect(completed.eventType).toBe('lm.completed');
    expect(completed.outputData.output).toBe('pong');
    expect(completed.metadata).toMatchObject({
      provider: 'openai', cached_tokens: '3', total_tokens: '7',
      capture_mode: 'observed', source: 'vercel_ai',
    });
  });

  it('emits lm.failed through the model execution wrapper', async () => {
    const ctx = fakeContext('fn-error');
    wrapAISDK({ generateText: vi.fn() });
    await runWithContext({ runId: 'run-2', executionContext: ctx as any }, () =>
      journalTelemetry.onLanguageModelCallStart({
        callId: 'call-error', provider: 'anthropic', modelId: 'claude-sonnet-4', messages: [],
      }),
    );
    await expect(journalTelemetry.executeLanguageModelCall({
      callId: 'call-error',
      execute: async () => { throw new Error('provider unavailable'); },
    })).rejects.toThrow('provider unavailable');
    expect(capturedEvents(ctx).map((event) => event.eventType)).toEqual(['lm.started', 'lm.failed']);
  });

  it('captures tool completion and preserves its model-parent snapshot', async () => {
    const ctx = fakeContext('agent-parent');
    wrapAISDK({ generateText: vi.fn() });
    await runWithContext({ runId: 'run-tool', executionContext: ctx as any }, () =>
      journalTelemetry.onToolExecutionStart({
        callId: 'call-tool', toolCall: { toolCallId: 'tool-1', toolName: 'weather', input: { city: 'SF' } },
      }),
    );
    await journalTelemetry.onToolExecutionEnd({
      callId: 'call-tool',
      toolCall: { toolCallId: 'tool-1', toolName: 'weather' },
      toolOutput: { type: 'tool-result', output: { temp: 65 } },
      toolExecutionMs: 4,
    });
    const [started, completed] = capturedEvents(ctx);
    expect(started.eventType).toBe('tool_call.started');
    expect(started.parentCorrelationId).toBe('agent-parent');
    expect(completed.eventType).toBe('tool_call.completed');
    expect(completed.metadata.duration_ms).toBe('4');
  });

  it('returns telemetry-enabled helpers without mutating the frozen namespace', () => {
    const generateText = vi.fn((options) => options);
    const ai = Object.freeze({ generateText });
    const wrapped = wrapAISDK(ai);
    const options = (wrapped as any).generateText({ model: 'test' });
    expect(wrapped).not.toBe(ai);
    expect(options.experimental_telemetry.isEnabled).toBe(true);
    expect(options.experimental_telemetry.integrations).toContain(journalTelemetry);
  });

  it('translates legacy OTel spans and is idempotent when enabled twice', async () => {
    const before = ((globalThis as any).AI_SDK_TELEMETRY_INTEGRATIONS ?? []).length;
    await enableVercelAICapture();
    await enableVercelAICapture();
    const after = ((globalThis as any).AI_SDK_TELEMETRY_INTEGRATIONS ?? []).length;
    expect(after - before).toBeLessThanOrEqual(1);

    const ctx = fakeContext('otel-parent');
    const processor = new JournalSpanProcessor();
    const span: any = {
      name: 'ai.generateText.doGenerate',
      attributes: {
        'ai.model.provider': 'openai',
        'ai.model.id': 'gpt-4o-mini',
        'ai.usage.promptTokens': 2,
        'ai.usage.completionTokens': 1,
        'ai.response.text': 'pong',
      },
      status: { code: 1 },
    };
    await runWithContext({ runId: 'run-otel', executionContext: ctx as any }, async () => {
      processor.onStart(span);
    });
    processor.onEnd(span);
    await vi.waitFor(() => expect(ctx.emit).toHaveBeenCalledTimes(2));
    expect(capturedEvents(ctx).map((event) => event.eventType)).toEqual(['lm.started', 'lm.completed']);
  });

  it('is a pure no-op without ambient context', async () => {
    wrapAISDK({ generateText: vi.fn() });
    await journalTelemetry.onLanguageModelCallStart({
      callId: 'no-context', provider: 'openai', modelId: 'gpt-4o-mini', messages: [],
    });
    await journalTelemetry.onLanguageModelCallEnd({ callId: 'no-context', usage: {}, content: [] });
  });

  it('honors the per-library kill switch', async () => {
    process.env.AGNT5_CAPTURE_VERCEL_AI = 'false';
    expect(await enableVercelAICapture()).toBe(false);
    const ctx = fakeContext('disabled');
    wrapAISDK({ generateText: vi.fn() });
    await runWithContext({ runId: 'disabled', executionContext: ctx as any }, () =>
      journalTelemetry.onLanguageModelCallStart({
        callId: 'disabled', provider: 'openai', modelId: 'gpt-4o-mini', messages: [],
      }),
    );
    expect(ctx.emit).not.toHaveBeenCalled();
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
