import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** ctx.progress: report how far a run has got (AGNT5-1569). */

import { EventEmitter } from '../event-emitter.js';
import { ProgressReporter, progressReport, MAX_PROGRESS_MESSAGE_CHARS } from '../progress.js';
import type { ProgressReport } from '../progress.js';
import { ContextImpl } from '../context.js';
import { WorkerlessContext } from '../workerless-context.js';
import { Worker } from '../worker.js';
import { FunctionRegistry, fn } from '../function.js';
import { WorkflowRegistry, workflow } from '../workflow.js';

function nativeWorker() {
  return {
    queueEvent: vi.fn(),
    emitCheckpoint: vi.fn(async (..._args: any[]) => {}),
    emitCheckpointBatch: vi.fn(async (..._args: any[]) => {}),
    persistWorkflowState: vi.fn(async () => {}),
  };
}

type Native = ReturnType<typeof nativeWorker>;

/** The progress records appended, as [progress, total, message]. */
function figures(native: Native): Array<[number, number | undefined, string | undefined]> {
  return native.emitCheckpoint.mock.calls
    .filter(args => args[1] === 'progress.update')
    .map(args => {
      const data = JSON.parse(args[2]);
      return [data.progress, data.total, data.message];
    });
}

const SOURCE = { name: 'embed_docs', correlationId: 'fn-cid', parentCorrelationId: 'run-cid' };

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('progressReport', () => {
  it('carries progress, total and message', () => {
    expect(progressReport(3, { total: 10, message: 'Embedding' })).toEqual({
      progress: 3,
      total: 10,
      message: 'Embedding',
    });
    expect(progressReport(0.5)).toEqual({ progress: 0.5 });
    // An empty message says nothing; a long one is cut.
    expect(progressReport(1, { message: '' })).toEqual({ progress: 1 });
    expect(progressReport(1, { message: 'x'.repeat(5000) }).message).toHaveLength(MAX_PROGRESS_MESSAGE_CHARS);
  });

  it.each([
    [['3'], TypeError],
    [[undefined], TypeError],
    [[1, { total: '10' }], TypeError],
    [[1, { message: 42 }], TypeError],
    // Only undefined leaves an option out.
    [[1, { total: null }], TypeError],
    [[1, { message: null }], TypeError],
    [[Number.NaN], RangeError],
    [[Number.POSITIVE_INFINITY], RangeError],
    [[1, { total: 0 }], RangeError],
    [[1, { total: -5 }], RangeError],
  ])('rejects %j', (args, error) => {
    expect(() => (progressReport as any)(...args)).toThrow(error);
  });
});

describe('ProgressReporter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function reporter() {
    const sent: ProgressReport[] = [];
    const r = new ProgressReporter(async report => {
      sent.push(report);
    }, 1000);
    return { r, sent };
  }

  it('sends the first report at once and then only the latest each second', async () => {
    const { r, sent } = reporter();
    r.report({ progress: 1, total: 50 });
    // In the same call: a handler that returns right away still gets it out.
    expect(sent).toEqual([{ progress: 1, total: 50 }]);
    for (let i = 2; i <= 50; i++) r.report({ progress: i, total: 50 });
    await settle(500);
    expect(sent).toHaveLength(1);
    await settle(500);
    expect(sent).toEqual([{ progress: 1, total: 50 }, { progress: 50, total: 50 }]);
  });

  it('never goes backwards', async () => {
    const { r, sent } = reporter();
    expect(r.report({ progress: 5, total: 10, message: 'five' })).toBe(true);
    expect(r.report({ progress: 2, total: 10, message: 'two' })).toBe(false);
    expect(r.report({ progress: 5, total: 10, message: 'five' })).toBe(false);
    // The same figure with a new message still goes out.
    expect(r.report({ progress: 5, total: 10, message: 'checking' })).toBe(true);
    await settle(2000);
    expect(sent).toEqual([
      { progress: 5, total: 10, message: 'five' },
      { progress: 5, total: 10, message: 'checking' },
    ]);
  });

  it('hands over the waiting report when drained, then takes no more', async () => {
    const { r, sent } = reporter();
    r.report({ progress: 1 });
    r.report({ progress: 2 }); // waiting out the interval
    r.drain();
    expect(sent).toEqual([{ progress: 1 }, { progress: 2 }]);
    expect(r.report({ progress: 3 })).toBe(false);
    await settle(2000);
    expect(sent).toEqual([{ progress: 1 }, { progress: 2 }]);
  });

  it('drops what is waiting when closed', async () => {
    const { r, sent } = reporter();
    r.report({ progress: 1 });
    r.report({ progress: 2 });
    r.close();
    await settle(2000);
    expect(sent).toEqual([{ progress: 1 }]);
  });

  it('keeps the source of an accepted report only', async () => {
    const sent: Array<[number, string]> = [];
    const r = new ProgressReporter<string>(async (report, source) => {
      sent.push([report.progress, source]);
    }, 1000);
    r.report({ progress: 5 }, 'workflow');
    r.report({ progress: 7 }, 'step'); // accepted, waiting
    r.report({ progress: 3 }, 'workflow'); // backwards: rejected
    await settle(1000);
    expect(sent).toEqual([[5, 'workflow'], [7, 'step']]);
  });

  it('never fails the run when a report cannot be sent', async () => {
    let fail = true;
    const sent: ProgressReport[] = [];
    const r = new ProgressReporter(async report => {
      if (fail) throw new Error('engine unavailable');
      sent.push(report);
    }, 1000);
    r.report({ progress: 1 });
    await settle();
    fail = false;
    r.report({ progress: 2 });
    await settle(1000);
    expect(sent).toEqual([{ progress: 2 }]);
  });
});

describe('EventEmitter.reportProgress', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('appends a progress.update record at once, not to the held queue', async () => {
    const native = nativeWorker();
    // A non-streaming pull run: sdk-core holds queued events until it completes.
    const emitter = new EventEmitter('run-1', { lease_id: 'lease-1' }, { deferLifecycle: true });
    emitter.setWorker(native);
    expect(emitter.reportProgress({ progress: 1, total: 4, message: 'Embedded a.md' }, SOURCE)).toBe(true);
    await settle();

    expect(figures(native)).toEqual([[1, 4, 'Embedded a.md']]);
    expect(native.queueEvent).not.toHaveBeenCalled();
    const [runId, eventType, data, , metadata] = native.emitCheckpoint.mock.calls[0];
    expect(runId).toBe('run-1');
    expect(eventType).toBe('progress.update');
    expect(JSON.parse(data)).toMatchObject({
      event_type: 'progress.update',
      name: 'embed_docs',
      correlation_id: 'fn-cid',
      parent_correlation_id: 'run-cid',
    });
    expect(metadata).toMatchObject({ lease_id: 'lease-1', cid: 'fn-cid', pcid: 'run-cid' });
  });

  it('writes the waiting report before the run ends, and nothing after', async () => {
    const native = nativeWorker();
    const emitter = new EventEmitter('run-1');
    emitter.setWorker(native);
    emitter.reportProgress({ progress: 1, total: 3 }, SOURCE);
    emitter.reportProgress({ progress: 2, total: 3 }, SOURCE); // waiting out the interval
    await emitter.flush();
    expect(figures(native)).toEqual([[1, 3, undefined], [2, 3, undefined]]);
    expect(emitter.reportProgress({ progress: 3, total: 3 }, SOURCE)).toBe(false);
    await settle(2000);
    expect(figures(native)).toHaveLength(2);
  });

  it('writes the waiting report ahead of the record that ends the run', async () => {
    const native = nativeWorker();
    const emitter = new EventEmitter('run-1');
    emitter.setWorker(native);
    emitter.reportProgress({ progress: 1, total: 2 }, SOURCE);
    emitter.reportProgress({ progress: 2, total: 2 }, SOURCE);
    await emitter.emit({
      eventType: 'run.completed',
      eventId: 'done',
      name: 'run',
      correlationId: 'run-cid',
      parentCorrelationId: null,
      timestampNs: 1n,
      metadata: {},
    } as any);
    expect(native.emitCheckpoint.mock.calls.map(args => args[1])).toEqual([
      'progress.update',
      'progress.update',
      'run.completed',
    ]);
  });

  it('attributes a waiting report to the call that made it', async () => {
    const native = nativeWorker();
    const emitter = new EventEmitter('run-1');
    emitter.setWorker(native);
    emitter.reportProgress({ progress: 5 }, SOURCE);
    emitter.reportProgress({ progress: 7 }, { ...SOURCE, correlationId: 'step-cid' });
    emitter.reportProgress({ progress: 3 }, { ...SOURCE, correlationId: 'other-cid' }); // rejected
    await emitter.flush();
    const cids = native.emitCheckpoint.mock.calls
      .filter(args => args[1] === 'progress.update')
      .map(args => JSON.parse(args[2]).correlation_id);
    expect(cids).toEqual(['fn-cid', 'step-cid']);
  });

  it('keeps a failed lifecycle batch for the end of the run to retry', async () => {
    const native = nativeWorker();
    native.emitCheckpointBatch.mockRejectedValueOnce(new Error('append failed'));
    const emitter = new EventEmitter('run-1');
    emitter.setWorker(native);
    const started = (eventType: string) =>
      ({
        eventType,
        eventId: eventType,
        name: 'run',
        correlationId: 'run-cid',
        parentCorrelationId: null,
        timestampNs: 1n,
        metadata: {},
      }) as any;
    // Coalesced lifecycle checkpoints, waiting for a barrier.
    await emitter.emit(started('run.started'));
    await emitter.emit(started('function.started'));
    // The progress append is that barrier; the batch fails under it.
    emitter.reportProgress({ progress: 1 }, SOURCE);
    await settle();
    expect(figures(native)).toEqual([], 'nothing written ahead of the lifecycle records');
    // The end of the run retries the same batch, so the failure isn't lost.
    await emitter.flush();
    const batches = native.emitCheckpointBatch.mock.calls.map(args =>
      (args[0] as Array<{ eventType: string }>).map(e => e.eventType),
    );
    expect(batches).toEqual([
      ['run.started', 'function.started'],
      ['run.started', 'function.started'],
    ]);

    // And a batch that keeps failing fails the run's flush.
    const failing = nativeWorker();
    failing.emitCheckpointBatch.mockRejectedValue(new Error('append failed'));
    const doomed = new EventEmitter('run-2');
    doomed.setWorker(failing);
    await doomed.emit(started('run.started'));
    doomed.reportProgress({ progress: 1 }, SOURCE);
    await settle();
    await expect(doomed.flush()).rejects.toThrow('append failed');
  });

  it('drops the waiting report of a run cancelled elsewhere', async () => {
    const native = nativeWorker();
    const emitter = new EventEmitter('run-1');
    emitter.setWorker(native);
    emitter.reportProgress({ progress: 1 }, SOURCE);
    emitter.reportProgress({ progress: 2 }, SOURCE); // waiting out the interval
    emitter.discardProgress();
    await emitter.flush();
    await settle(2000);
    expect(figures(native)).toEqual([[1, undefined, undefined]]);
  });

  it('is a no-op without a worker', () => {
    expect(new EventEmitter('run-1').reportProgress({ progress: 1 }, SOURCE)).toBe(false);
  });
});

describe('ctx.progress', () => {
  it('is checked even where nothing listens', () => {
    const local = new ContextImpl('inv', 'run', 0, 'svc');
    expect(() => local.progress(1, { total: 2 })).not.toThrow();
    expect(() => local.progress(Number.NaN)).toThrow(RangeError);
    const workerless = new WorkerlessContext('inv', 'run', 0, 'svc');
    expect(() => workerless.progress(1)).not.toThrow();
    expect(() => workerless.progress('1' as any)).toThrow(TypeError);
  });

  describe('on a dispatched run', () => {
    beforeEach(() => {
      FunctionRegistry.clear();
      WorkflowRegistry.clear();
    });

    it('a cancelled function writes nothing after the gateway cancelled it', async () => {
      const native = nativeWorker();
      const worker = new Worker('progress-test', { serviceVersion: '0.1.0' });
      (worker as any).nativeWorker = native;
      fn('embed_docs').run(async ctx => {
        ctx.progress(1, { total: 3 });
        ctx.progress(2, { total: 3 }); // waiting out the interval
        // CancelExecution arrives: the gateway has written run.cancelled.
        (worker as any).inflight.get('run-progress').abort();
        throw new Error('aborted');
      });
      const result = await (worker as any)
        .processMessage({
          invocationId: 'run-progress',
          componentName: 'embed_docs',
          componentType: 'function',
          inputJson: '{}',
          metadata: { run_id: 'run-progress', component_name: 'embed_docs' },
        })
        .then(JSON.parse);
      expect(result.eventType).toBe('run.cancelled');
      expect(figures(native)).toEqual([[1, 3, undefined]]);
    });

    it('a cancelled workflow writes nothing after the gateway cancelled it', async () => {
      const native = nativeWorker();
      const worker = new Worker('progress-test', { serviceVersion: '0.1.0' });
      (worker as any).nativeWorker = native;
      workflow('triage', async ctx => {
        ctx.progress(1, { total: 3 });
        ctx.progress(2, { total: 3 }); // waiting out the interval
        (worker as any).inflight.get('run-progress').abort();
        throw new Error('aborted');
      });
      const result = await (worker as any)
        .processMessage({
          invocationId: 'run-progress',
          componentName: 'triage',
          componentType: 'workflow',
          inputJson: '{}',
          metadata: { run_id: 'run-progress', component_name: 'triage' },
        })
        .then(JSON.parse);
      expect(result.eventType).toBe('run.cancelled');
      // workflow.failed is still emitted while unwinding; the waiting report
      // must not ride ahead of it.
      const types = native.emitCheckpoint.mock.calls.map(args => args[1]);
      expect(types).toContain('workflow.failed');
      expect(figures(native)).toEqual([[1, 3, undefined]]);
    });

    it("a function's report hangs off its run like its lifecycle records", async () => {
      const native = nativeWorker();
      fn('embed_docs').run(async ctx => {
        ctx.progress(1, { total: 1 });
        return { ok: true };
      });
      await dispatch(native, 'embed_docs', 'function');
      const calls = native.emitCheckpoint.mock.calls;
      const progress = calls.find(args => args[1] === 'progress.update')!;
      const data = JSON.parse(progress[2]);
      const runCid = 'run-progress'.slice(0, 8);
      expect(data.parent_correlation_id).toBe(runCid);
      expect(progress[4].pcid).toBe(runCid);
      // And sits under the function, as function.started does.
      const started = [...calls, ...native.emitCheckpointBatch.mock.calls.flatMap(args =>
        (args[0] as any[]).map(e => [e.runId, e.eventType, e.eventData]))]
        .find(args => args[1] === 'function.started')!;
      expect(data.correlation_id).toBe(JSON.parse(started[2]).correlation_id);
    });

    function dispatch(native: Native, componentName: string, componentType: string) {
      const worker = new Worker('progress-test', { serviceVersion: '0.1.0' });
      (worker as any).nativeWorker = native;
      return (worker as any)
        .processMessage({
          invocationId: 'run-progress',
          componentName,
          componentType,
          inputJson: '{}',
          metadata: { run_id: 'run-progress', component_name: componentName },
        })
        .then(JSON.parse);
    }

    it('a function reports progress', async () => {
      const native = nativeWorker();
      fn('embed_docs').run(async ctx => {
        // Returns straight after reporting: the report must still land.
        ctx.progress(1, { total: 2, message: 'Embedded a.md' });
        return { ok: true };
      });
      await dispatch(native, 'embed_docs', 'function');
      expect(figures(native)).toEqual([[1, 2, 'Embedded a.md']]);
      const data = JSON.parse(native.emitCheckpoint.mock.calls.find(a => a[1] === 'progress.update')![2]);
      expect(data.name).toBe('embed_docs');
    });

    it('a workflow reports progress', async () => {
      const native = nativeWorker();
      workflow('triage', async ctx => {
        ctx.progress(3, { total: 5, message: 'Drafting' });
        ctx.progress(5, { total: 5, message: 'Done' }); // waiting out the interval
        return { ok: true };
      });
      await dispatch(native, 'triage', 'workflow');
      expect(figures(native)).toEqual([
        [3, 5, 'Drafting'],
        [5, 5, 'Done'],
      ]);
    });
  });
});
