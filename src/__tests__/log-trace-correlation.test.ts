import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Log records must carry the run's trace id (AGNT5-1073, AGNT5-1080).
 *
 * Every TypeScript log record went out with traceId and spanId hardcoded to
 * null — in SimpleContext.logger, ContextImpl.logger and ContextLogger alike —
 * so logs could not be joined to their trace. AGNT5-1073 wired the ids through
 * to the NAPI bridge, but they stayed null in production because the resolver
 * looked for a loose `trace_id` metadata entry that the gateway dispatch path
 * does not set: it stamps a W3C `traceparent`. AGNT5-1080 reads that instead.
 *
 * These tests mock the NAPI bridge, so they pin what the TypeScript half hands
 * over and nothing past it. That boundary is exactly where the AGNT5-1080 bug
 * hid, so the bridge's own tolerance for a missing span id is pinned in Rust,
 * in native/src/lib.rs.
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
const OTHER_TRACE_ID = '01a06662eea474f0bb8e6ade8e0b589e';
const SPAN_ID = 'd8e314d6ce264a7b';

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

  // The gateway's `ensure_traceparent` puts a traceparent on every dispatch and
  // never a loose `trace_id`, so this is the source that fires on a real run.
  // Missing it was why every TS log record went out uncorrelated (AGNT5-1080).
  it('reads both ids from the traceparent the gateway stamps', async () => {
    const metadata = { traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` };
    await runWithContext({ runId: RUN_ID, metadata }, async () => {
      expect(currentTraceCorrelation()).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID });
    });
  });

  it('prefers the traceparent over a loose trace_id, since it carries a span too', async () => {
    const metadata = { traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`, trace_id: OTHER_TRACE_ID };
    await runWithContext({ runId: RUN_ID, metadata }, async () => {
      expect(currentTraceCorrelation()).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID });
    });
  });

  it('falls back to the loose trace_id when the traceparent is unusable', async () => {
    const metadata = { traceparent: 'not-a-traceparent', trace_id: TRACE_ID };
    await runWithContext({ runId: RUN_ID, metadata }, async () => {
      expect(currentTraceCorrelation()).toEqual({ traceId: TRACE_ID, spanId: null });
    });
  });

  it.each([
    ['too few fields', `00-${TRACE_ID}`],
    ['a short trace id', `00-abc-${SPAN_ID}-01`],
    ['a short span id', `00-${TRACE_ID}-abc-01`],
    ['an all-zero trace id', `00-${'0'.repeat(32)}-${SPAN_ID}-01`],
    ['an all-zero span id', `00-${TRACE_ID}-${'0'.repeat(16)}-01`],
  ])('ignores a traceparent with %s', async (_label, traceparent) => {
    await runWithContext({ runId: RUN_ID, metadata: { traceparent } }, async () => {
      expect(currentTraceCorrelation()).toEqual({ traceId: null, spanId: null });
    });
  });

  // The oss-server dispatch path sets these two as separate entries. The span id
  // was previously ignored, and the native bridge then dropped the half pair.
  it('pairs a loose span_id with its trace_id', async () => {
    const metadata = { trace_id: TRACE_ID, span_id: SPAN_ID };
    await runWithContext({ runId: RUN_ID, metadata }, async () => {
      expect(currentTraceCorrelation()).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID });
    });
  });

  it('drops a span id that has no trace id, which points nowhere', async () => {
    await runWithContext({ runId: RUN_ID, metadata: { span_id: SPAN_ID } }, async () => {
      expect(currentTraceCorrelation()).toEqual({ traceId: null, spanId: null });
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
