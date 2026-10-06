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
    await settle();
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
    expect(sent).toEqual([{ progress: 5, total: 10, message: 'checking' }]);
  });

  it('drops what is pending once closed', async () => {
    const { r, sent } = reporter();
    r.report({ progress: 1 });
    await settle();
    r.report({ progress: 2 });
    r.close();
    expect(r.report({ progress: 3 })).toBe(false);
    await settle(2000);
    expect(sent).toEqual([{ progress: 1 }]);
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

  it('sends nothing once the run has finished', async () => {
    const native = nativeWorker();
    const emitter = new EventEmitter('run-1');
    emitter.setWorker(native);
    emitter.reportProgress({ progress: 1, total: 3 }, SOURCE);
    await settle();
    emitter.reportProgress({ progress: 2, total: 3 }, SOURCE);
    await emitter.flush();
    expect(emitter.reportProgress({ progress: 3, total: 3 }, SOURCE)).toBe(false);
    await settle(2000);
    expect(figures(native)).toEqual([[1, 3, undefined]]);
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
        ctx.progress(1, { total: 2, message: 'Embedded a.md' });
        // Give the first report its moment on the event loop.
        await new Promise(resolve => setTimeout(resolve, 5));
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
        await new Promise(resolve => setTimeout(resolve, 5));
        return { ok: true };
      });
      await dispatch(native, 'triage', 'workflow');
      expect(figures(native)).toEqual([[3, 5, 'Drafting']]);
    });
  });
});
