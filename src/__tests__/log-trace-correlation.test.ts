import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Log records must carry the run's trace id (AGNT5-1073).
 *
 * Every TypeScript log record went out with traceId and spanId hardcoded to
 * null — in SimpleContext.logger, ContextImpl.logger and ContextLogger alike —
 * so logs could not be joined to their trace even though sdk-core stamps
 * `trace_id` on the dispatch metadata and the NAPI bridge accepts both fields.
 */

const bridge = vi.fn();
vi.mock('../native-loader.js', () => ({
  // No `Span` on the bindings, so tracing falls back to in-process span ids.
  getLoadedNativeBindings: () => ({ logFromTypescript: bridge }),
  tryLoadNativeBindings: () => ({ logFromTypescript: bridge }),
  loadNativeBindings: () => ({ logFromTypescript: bridge }),
}));

const { Worker } = await import('../worker.js');
const { FunctionRegistry, fn } = await import('../function.js');
const { ContextLogger, currentTraceCorrelation, setLogLevel } = await import('../logging.js');
const { runWithContext } = await import('../async-context.js');
const { withSpan } = await import('../tracing.js');

const RUN_ID = '01a05cd2-591a-7f51-be2a-4d7d5e7cc1ba';
const TRACE_ID = '01a05cd2591f7be08bb33d7df5f1de07';

/** [level, message, runId, traceId, spanId] as handed to the NAPI bridge. */
function calls() {
  return bridge.mock.calls;
}

describe('currentTraceCorrelation', () => {
  beforeEach(() => {
    bridge.mockClear();
    FunctionRegistry.clear();
    setLogLevel('DEBUG');
  });

  it('is null outside a run', () => {
    // Worker startup logs belong to no trace and must not borrow one.
    expect(currentTraceCorrelation()).toEqual({ traceId: null, spanId: null });
  });

  it('reads the trace id the runtime stamps on dispatch metadata', async () => {
    await runWithContext({ runId: RUN_ID, metadata: { trace_id: TRACE_ID } }, async () => {
      expect(currentTraceCorrelation()).toEqual({ traceId: TRACE_ID, spanId: null });
    });
  });

  it('prefers an active span, which carries both ids', async () => {
    await runWithContext({ runId: RUN_ID, metadata: { trace_id: TRACE_ID } }, async () => {
      await withSpan('step', async () => {
        const { traceId, spanId } = currentTraceCorrelation();
        expect(spanId).toBeTruthy();
        expect(traceId).toBeTruthy();
        expect(traceId).not.toBe(TRACE_ID);
      });
    });
  });

  it('ignores an empty trace id rather than stamping a blank', async () => {
    await runWithContext({ runId: RUN_ID, metadata: { trace_id: '' } }, async () => {
      expect(currentTraceCorrelation().traceId).toBeNull();
    });
  });
});

describe('trace correlation on emitted log records', () => {
  beforeEach(() => {
    bridge.mockClear();
    FunctionRegistry.clear();
    setLogLevel('DEBUG');
  });

  it('stamps the trace id on a dispatched run’s log records', async () => {
    fn('ks_analyze_text').run(async (ctx: any) => {
      ctx.logger.info('Analyzing: probe');
      return { ok: true };
    });

    const worker = new Worker('kitchen-sink', { serviceVersion: '0.1.0' });
    await (worker as any).processMessage({
      invocationId: RUN_ID,
      componentName: 'ks_analyze_text',
      componentType: 'function',
      inputJson: '{}',
      metadata: { run_id: RUN_ID, trace_id: TRACE_ID },
    });

    const emitted = calls().filter((c) => /run\.started|Analyzing|run\.completed/.test(String(c[1])));
    expect(emitted.length).toBeGreaterThanOrEqual(3);
    for (const call of emitted) {
      expect(call[2]).toBe(RUN_ID);
      expect(call[3], `traceId missing on: ${call[1]}`).toBe(TRACE_ID);
    }
  });

  it('stamps the trace id on ContextLogger records too', async () => {
    await runWithContext({ runId: RUN_ID, metadata: { trace_id: TRACE_ID } }, async () => {
      new ContextLogger('worker', { runId: RUN_ID }).error('run.failed | boom');
    });

    const call = calls().find((c) => /run\.failed/.test(String(c[1])));
    expect(call?.[3]).toBe(TRACE_ID);
  });

  it('leaves records outside a run uncorrelated', async () => {
    new ContextLogger('worker', {}).info('worker booting');

    const call = calls().find((c) => /worker booting/.test(String(c[1])));
    expect(call?.[3]).toBeNull();
    expect(call?.[4]).toBeNull();
  });
});
