import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const agentsMock = vi.hoisted(() => ({
  addTraceProcessor: vi.fn(),
  setTracingDisabled: vi.fn(),
  currentSpan: undefined as any,
}));

vi.mock('@openai/agents', () => ({
  addTraceProcessor: agentsMock.addTraceProcessor,
  setTracingDisabled: agentsMock.setTracingDisabled,
  getCurrentSpan: () => agentsMock.currentSpan,
}));

import { Completions } from 'openai/resources/chat/completions';
import { runWithContext } from '../async-context.js';
import {
  CaptureProcessor,
  disableOpenAIAgentsCapture,
  enableOpenAIAgentsCapture,
  suppressesClientCapture,
} from '../integrations/openai-agents.js';
import { disableOpenAICapture, enableOpenAICapture } from '../integrations/openai.js';

beforeEach(() => {
  delete process.env.AGNT5_CAPTURE;
  delete process.env.AGNT5_CAPTURE_OPENAI_AGENTS;
  delete process.env.AGNT5_CAPTURE_OPENAI;
  disableOpenAIAgentsCapture();
  disableOpenAICapture();
  agentsMock.addTraceProcessor.mockClear();
  agentsMock.setTracingDisabled.mockClear();
  agentsMock.currentSpan = undefined;
});

afterEach(() => {
  disableOpenAIAgentsCapture();
  disableOpenAICapture();
  delete process.env.AGNT5_CAPTURE_OPENAI_AGENTS;
});

describe('OpenAI Agents capture', () => {
  it('translates agent, generation, and function spans with nested parents', async () => {
    const ctx = fakeContext('fn-parent');
    await enableOpenAIAgentsCapture();
    const processor = registeredProcessor();
    const agent = span('trace-1', 'agent-1', null, { type: 'agent', name: 'helper', tools: ['lookup'] });
    const generation = span('trace-1', 'lm-1', 'agent-1', {
      type: 'generation',
      model: 'gpt-4o-mini',
      input: [{ role: 'user', content: 'ping' }],
      output: [{ role: 'assistant', content: 'pong' }],
      usage: { input_tokens: 4, output_tokens: 1 },
    });
    const tool = span('trace-1', 'tool-1', 'agent-1', {
      type: 'function', name: 'lookup', input: '{"q":"x"}', output: 'result',
    });

    await runWithContext({ runId: 'run-1', executionContext: ctx as any }, async () => {
      await processor.onSpanStart(agent);
      await processor.onSpanStart(generation);
      await processor.onSpanStart(tool);
    });
    await processor.onSpanEnd(generation);
    await processor.onSpanEnd(tool);
    await processor.onSpanEnd(agent);

    const events = capturedEvents(ctx);
    expect(events.map((event) => event.eventType)).toEqual([
      'agent.started', 'lm.started', 'tool_call.started',
      'lm.completed', 'tool_call.completed', 'agent.completed',
    ]);
    expect(events[1].parentCorrelationId).toBe(events[0].correlationId);
    expect(events[2].parentCorrelationId).toBe(events[0].correlationId);
    expect(events[3].metadata).toMatchObject({
      input_tokens: '4', output_tokens: '1', total_tokens: '5',
      capture_mode: 'observed', source: 'openai_agents',
    });
  });

  it('maps span errors to lm.failed', async () => {
    const ctx = fakeContext('fn-error');
    await enableOpenAIAgentsCapture();
    const processor = registeredProcessor();
    const generation = span('trace-2', 'lm-2', null, { type: 'generation', model: 'gpt-4o-mini' });
    await runWithContext({ runId: 'run-2', executionContext: ctx as any }, () => processor.onSpanStart(generation));
    generation.error = { message: 'model failed' };
    await processor.onSpanEnd(generation);
    expect(capturedEvents(ctx).map((event) => event.eventType)).toEqual(['lm.started', 'lm.failed']);
  });

  it('does nothing without ambient context', async () => {
    await enableOpenAIAgentsCapture();
    const processor = registeredProcessor();
    await processor.onSpanStart(span('trace-3', 'agent-3', null, { type: 'agent', name: 'helper' }));
    expect((processor as any).spans.size).toBe(0);
  });

  it('enables tracing and registers only once across duplicate enable calls', async () => {
    await enableOpenAIAgentsCapture();
    await enableOpenAIAgentsCapture();
    expect(agentsMock.setTracingDisabled).toHaveBeenCalledWith(false);
    expect(agentsMock.addTraceProcessor).toHaveBeenCalledOnce();
  });

  it('suppresses the raw OpenAI patch during generation spans', async () => {
    const original = Completions.prototype.create;
    const provider = vi.fn(async () => ({ model: 'gpt-4o-mini', choices: [], usage: {} }));
    Completions.prototype.create = provider as any;
    try {
      await enableOpenAIAgentsCapture();
      await enableOpenAICapture();
      agentsMock.currentSpan = { spanData: { type: 'generation' } };
      const ctx = fakeContext('fn-dedupe');
      await runWithContext(
        { runId: 'run-dedupe', executionContext: ctx as any },
        () => (Completions.prototype.create as any).call({}, { model: 'gpt-4o-mini', messages: [] }),
      );
      expect(suppressesClientCapture()).toBe(true);
      expect(provider).toHaveBeenCalledOnce();
      expect(ctx.emit).not.toHaveBeenCalled();
    } finally {
      disableOpenAICapture();
      Completions.prototype.create = original;
    }
  });

  it('honors the per-library kill switch', async () => {
    process.env.AGNT5_CAPTURE_OPENAI_AGENTS = '0';
    expect(await enableOpenAIAgentsCapture()).toBe(false);
    expect(agentsMock.addTraceProcessor).not.toHaveBeenCalled();
  });
});

function registeredProcessor(): CaptureProcessor {
  return agentsMock.addTraceProcessor.mock.calls.at(-1)?.[0] as CaptureProcessor;
}

function span(traceId: string, spanId: string, parentId: string | null, spanData: any): any {
  return { traceId, spanId, parentId, spanData, error: null };
}

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
