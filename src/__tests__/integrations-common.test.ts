import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithContext } from '../async-context.js';
import {
  ambientContext,
  buildLMCompleted,
  libraryCaptureEnabled,
  masterCaptureEnabled,
  newCaptureSpan,
  safeEmit,
} from '../integrations/_common.js';

const envKeys = ['AGNT5_CAPTURE', 'AGNT5_CAPTURE_OPENAI'] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('capture integration common helpers', () => {
  it('honors master and per-library kill switches', () => {
    process.env.AGNT5_CAPTURE = 'off';
    process.env.AGNT5_CAPTURE_OPENAI = '0';
    expect(masterCaptureEnabled()).toBe(false);
    expect(libraryCaptureEnabled('AGNT5_CAPTURE_OPENAI')).toBe(false);
    delete process.env.AGNT5_CAPTURE;
    delete process.env.AGNT5_CAPTURE_OPENAI;
    expect(masterCaptureEnabled()).toBe(true);
    expect(libraryCaptureEnabled('AGNT5_CAPTURE_OPENAI')).toBe(true);
  });

  it('uses the execution context and snapshots its current parent', async () => {
    const ctx = fakeContext('parent-a');
    expect(ambientContext()).toBeUndefined();
    await runWithContext({ runId: 'run-1', executionContext: ctx as any }, async () => {
      expect(ambientContext()).toBe(ctx);
      const span = newCaptureSpan(ctx as any);
      (ctx.getCurrentCorrelationId as ReturnType<typeof vi.fn>).mockReturnValue('parent-b');
      expect(span.parentCorrelationId).toBe('parent-a');
    });
  });

  it('keeps concurrent parent snapshots isolated', async () => {
    const parents = await Promise.all(['A', 'B'].map((parent) => {
      const ctx = fakeContext(parent);
      return runWithContext({ runId: parent, executionContext: ctx as any }, async () => {
        await new Promise((resolve) => setTimeout(resolve, parent === 'A' ? 8 : 2));
        return newCaptureSpan(ambientContext()!).parentCorrelationId;
      });
    }));
    expect(parents).toEqual(['A', 'B']);
  });

  it('never propagates emit failures', async () => {
    const ctx = fakeContext('parent');
    ctx.emit.mockRejectedValue(new Error('journal unavailable'));
    await expect(safeEmit(ctx as any, { eventType: 'lm.started' } as any)).resolves.toBeUndefined();
  });

  it('matches the Phase 1a lm.completed metadata contract', () => {
    const event = buildLMCompleted({
      source: 'openai',
      model: 'openai/gpt-4o-mini',
      provider: 'openai',
      correlationId: 'lm-1',
      parentCorrelationId: 'fn-1',
      durationMs: 12,
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
      cachedTokens: 3,
    });
    expect(event.metadata).toEqual({
      name: 'openai/gpt-4o-mini',
      model: 'openai/gpt-4o-mini',
      provider: 'openai',
      input_tokens: '5',
      output_tokens: '2',
      total_tokens: '7',
      cached_tokens: '3',
      capture_mode: 'observed',
      duration_ms: '12',
      source: 'openai',
    });
  });
});

function fakeContext(parent: string) {
  return {
    runId: `run-${parent}`,
    emit: vi.fn(async () => undefined),
    getCurrentCorrelationId: vi.fn(() => parent),
  };
}
