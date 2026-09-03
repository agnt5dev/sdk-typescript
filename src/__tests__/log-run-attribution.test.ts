import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Every application log record emitted during a run must carry that run's id
 * (AGNT5-1070).
 *
 * `get_run_logs` selects on the run id. A logger constructed without one — a
 * module-level `getLogger('…')`, or anything the SDK logs through — used to
 * send `null`, so those records reached the control plane unattributed and the
 * endpoint returned nothing for them. The worker already binds `runId` on the
 * propagated context for the duration of a dispatch; the logger now reads it.
 */

const bridge = vi.fn();
vi.mock('#native-loader', () => ({
  getLoadedNativeBindings: () => ({ logFromTypescript: bridge }),
  tryLoadNativeBindings: () => ({ logFromTypescript: bridge }),
  loadNativeBindings: () => ({ logFromTypescript: bridge }),
}));

const { Worker } = await import('../worker.js');
const { FunctionRegistry, fn } = await import('../function.js');
const { ContextLogger, currentRunId, getLogger, setLogLevel } = await import('../logging.js');
const { runWithContext } = await import('../async-context.js');

const RUN_ID = '01a05cd2-591a-7f51-be2a-4d7d5e7cc1ba';
const OTHER_RUN_ID = '01a05cd2-7c40-7aa2-9f11-2b6d0f9e4c33';
const TRACE_ID = '01a05cd2591f7be08bb33d7df5f1de07';

/** The run id argument of each record handed to the NAPI bridge. */
function recordFor(pattern: RegExp): any[] | undefined {
  return bridge.mock.calls.find((c) => pattern.test(String(c[1])));
}

beforeEach(() => {
  bridge.mockClear();
  FunctionRegistry.clear();
  setLogLevel('DEBUG');
});

describe('currentRunId', () => {
  it('is null outside a run', () => {
    // Worker startup logs belong to no run and must not borrow one.
    expect(currentRunId()).toBeNull();
  });

  it('reads the run id the worker binds at dispatch', async () => {
    await runWithContext({ runId: RUN_ID }, async () => {
      expect(currentRunId()).toBe(RUN_ID);
    });
  });

  it('ignores an empty run id rather than stamping a blank', async () => {
    await runWithContext({ runId: '' }, async () => {
      expect(currentRunId()).toBeNull();
    });
  });

  it('keeps concurrent runs apart', async () => {
    const seen: (string | null)[] = [];
    await Promise.all([
      runWithContext({ runId: RUN_ID }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(currentRunId());
      }),
      runWithContext({ runId: OTHER_RUN_ID }, async () => {
        seen.push(currentRunId());
      }),
    ]);
    expect(seen.sort()).toEqual([RUN_ID, OTHER_RUN_ID].sort());
  });
});

describe('run attribution on emitted log records', () => {
  it('attributes a module-level logger to the run it logged inside', async () => {
    // The case that returned zero rows: a logger that never knew the run id.
    const logger = getLogger('my-module');
    await runWithContext({ runId: RUN_ID }, async () => {
      logger.info('Handling function request');
    });

    expect(recordFor(/Handling function request/)?.[2]).toBe(RUN_ID);
  });

  it('leaves a record emitted outside a run unattributed', async () => {
    getLogger('my-module').info('worker booting');

    expect(recordFor(/worker booting/)?.[2]).toBeNull();
  });

  it('keeps an explicitly supplied run id over the ambient one', async () => {
    await runWithContext({ runId: OTHER_RUN_ID }, async () => {
      new ContextLogger('worker', { runId: RUN_ID }).info('explicit wins');
    });

    expect(recordFor(/explicit wins/)?.[2]).toBe(RUN_ID);
  });

  it('attributes every record of a dispatched run, not only ctx.logger ones', async () => {
    const internal = getLogger('agnt5.worker');
    fn('ks_analyze_text').run(async (ctx: any) => {
      internal.info('Handling function request: ks_analyze_text');
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

    const emitted = bridge.mock.calls.filter((c) =>
      /run\.started|Handling function request|Analyzing|run\.completed/.test(String(c[1])),
    );
    expect(emitted.length).toBeGreaterThanOrEqual(4);
    for (const call of emitted) {
      expect(call[2], `run id missing on: ${call[1]}`).toBe(RUN_ID);
    }
  });
});
