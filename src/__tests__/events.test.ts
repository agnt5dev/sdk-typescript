import { describe, expect, it } from 'vitest';

import {
  isCheckpointEvent,
  isSseOnlyEvent,
  lmCompleted,
  lmFailed,
  lmStarted,
  toolCallStarted,
} from '../events.js';

describe('event durability classification', () => {
  it.each([
    'lm.content_block.started',
    'lm.content_block.delta',
    'lm.content_block.completed',
  ])('classifies %s as transient', (eventType) => {
    expect(isSseOnlyEvent(eventType)).toBe(true);
    expect(isCheckpointEvent(eventType)).toBe(false);
  });

  it.each([
    'lm.started',
    'lm.completed',
    'lm.failed',
    'tool_call.started',
    'tool_call.completed',
    'tool_call.failed',
    'agent.started',
    'agent.completed',
    'agent.failed',
  ])('classifies captured lifecycle event %s as durable', (eventType) => {
    expect(isSseOnlyEvent(eventType)).toBe(false);
    expect(isCheckpointEvent(eventType)).toBe(true);
  });

  it('constructs the additive capture metadata as strings', () => {
    const started = lmStarted('lm-1', 'parent', {
      model: 'openai/gpt-4o-mini',
      provider: 'openai',
      messages: [],
      toolsCount: 0,
      source: 'openai',
      captureMode: 'observed',
    });
    const completed = lmCompleted('lm-1', 'parent', {
      model: 'openai/gpt-4o-mini',
      provider: 'openai',
      output: 'pong',
      inputTokens: 2,
      outputTokens: 1,
      totalTokens: 3,
      cachedTokens: 1,
      durationMs: 7,
      finishReason: 'stop',
      source: 'openai',
      captureMode: 'observed',
    });
    const failed = lmFailed('lm-2', 'parent', {
      model: 'openai/gpt-4o-mini',
      provider: 'openai',
      errorCode: 'Error',
      errorMessage: 'boom',
      durationMs: 9,
      source: 'openai',
      captureMode: 'observed',
    });
    const tool = toolCallStarted('tool-1', 'parent', {
      toolName: 'lookup',
      toolCallId: 'call-1',
      source: 'openai_agents',
      captureMode: 'observed',
    });

    expect(started.metadata.source).toBe('openai');
    expect(started.metadata.capture_mode).toBe('observed');
    expect(completed.metadata).toMatchObject({
      cached_tokens: '1',
      capture_mode: 'observed',
      duration_ms: '7',
      input_tokens: '2',
      output_tokens: '1',
      source: 'openai',
      total_tokens: '3',
    });
    expect(completed.finishReason).toBe('stop');
    expect(failed.metadata.duration_ms).toBe('9');
    expect(tool.metadata.source).toBe('openai_agents');
    expect(tool.metadata.capture_mode).toBe('observed');
    expect(Object.values(completed.metadata).every((value) => typeof value === 'string')).toBe(true);
  });

  it('supports explicit native provenance without changing untagged events', () => {
    const native = lmStarted('lm-native', 'parent', {
      model: 'openai/gpt-4o-mini',
      provider: 'openai',
      messages: [],
      toolsCount: 0,
      source: 'agnt5',
      captureMode: 'native',
    });
    const untagged = lmStarted('lm-untagged', 'parent', {
      model: 'openai/gpt-4o-mini',
      provider: 'openai',
      messages: [],
      toolsCount: 0,
    });

    expect(native.metadata).toMatchObject({ source: 'agnt5', capture_mode: 'native' });
    expect(untagged.metadata).not.toHaveProperty('source');
    expect(untagged.metadata).not.toHaveProperty('capture_mode');
  });
});
