import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Worker } from '../worker.js';
import { WorkflowRegistry, workflow } from '../workflow.js';

const metadata = {
  run_id: 'run-state', project_id: 'project-state', dispatch_mode: 'pull',
  worker_id: 'worker-state', worker_session_id: 'session-state', lease_id: 'lease-state',
  lease_attempt: '0', pull_completion_lifecycle_v1: 'true',
};

function nativeWorker() {
  return {
    queueEvent: vi.fn(), emitCheckpoint: vi.fn(async () => {}),
    emitCheckpointBatch: vi.fn(async () => {}),
    persistWorkflowState: vi.fn(async () => {}),
  };
}

function dispatch(native: ReturnType<typeof nativeWorker>, extra = {}) {
  const worker = new Worker('state-test', { serviceVersion: 'v1' });
  (worker as any).nativeWorker = native;
  return (worker as any).processMessage({
    invocationId: metadata.run_id, componentName: 'stateful', componentType: 'workflow',
    inputJson: '{}', metadata: { ...metadata, ...extra },
  }).then(JSON.parse);
}

function stateEvents(native: ReturnType<typeof nativeWorker>) {
  return native.emitCheckpoint.mock.calls.filter((args: any[]) => args[1] === 'workflow.state.changed');
}

describe('pull workflow state durability', () => {
  beforeEach(() => {
    WorkflowRegistry.clear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('waits for state acknowledgment before continuing, without blocking another run', async () => {
    let acknowledge!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>(r => { entered = r; });
    const ack = new Promise<void>(r => { acknowledge = r; });
    const native = nativeWorker();
    native.emitCheckpoint.mockImplementation(async (...args: any[]) => {
      if (args[1] === 'workflow.state.changed') { entered(); await ack; }
    });
    let continued = false;
    workflow('stateful', async ctx => {
      await ctx.set('stage', 'paid');
      continued = true;
      return ctx.get('stage');
    });
    const running = dispatch(native);
    // The old Map-only implementation completes the handler without an ack.
    await Promise.race([pending, running]);
    expect(continued).toBe(false);
    expect(stateEvents(native)).toHaveLength(1);
    acknowledge();
    expect((await running).eventType).toBe('run.completed');
    expect(continued).toBe(true);
    expect(native.persistWorkflowState).toHaveBeenCalledOnce();
    expect(native.persistWorkflowState.mock.calls[0]).toEqual([{
      runId: metadata.run_id, metadata: expect.objectContaining(metadata),
      stateJson: '{"stage":"paid"}',
    }]);
  });

  it('fails the workflow when a state checkpoint is rejected', async () => {
    const native = nativeWorker();
    native.emitCheckpoint.mockImplementation(async (...args: any[]) => {
      if (args[1] === 'workflow.state.changed') throw new Error('state append rejected');
    });
    workflow('stateful', async ctx => { await ctx.set('stage', 'paid'); return 'ok'; });
    expect((await dispatch(native)).eventType).toBe('run.failed');
    expect(native.persistWorkflowState).not.toHaveBeenCalled();
  });

  it('does not complete before the final snapshot acknowledgment', async () => {
    let acknowledge!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>(r => { entered = r; });
    const ack = new Promise<void>(r => { acknowledge = r; });
    const native = nativeWorker();
    native.persistWorkflowState.mockImplementation(async () => { entered(); await ack; });
    workflow('stateful', async ctx => { await ctx.set('stage', 'paid'); return 'ok'; });
    const running = dispatch(native);
    await Promise.race([pending, running]);
    expect(native.persistWorkflowState).toHaveBeenCalledOnce();
    expect(native.emitCheckpoint.mock.calls.some((c: any[]) => c[1] === 'workflow.completed')).toBe(false);
    acknowledge();
    expect((await running).eventType).toBe('run.completed');
  });

  it('fails completion on a rejected final snapshot', async () => {
    const native = nativeWorker();
    native.persistWorkflowState.mockRejectedValue(new Error('version conflict'));
    workflow('stateful', async ctx => { await ctx.set('stage', 'paid'); return 'ok'; });
    expect((await dispatch(native)).eventType).toBe('run.failed');
  });

  it('restores checkpointed state and durably records a deletion', async () => {
    const native = nativeWorker();
    workflow('stateful', async ctx => {
      expect(await ctx.get('stage')).toBe('paid');
      expect(await ctx.delete('stage')).toBe(true);
      return ctx.get('stage', 'deleted');
    });
    const result = await dispatch(native, { workflow_state: '{"stage":"paid"}' });
    expect(result.eventType).toBe('run.completed');
    expect(JSON.parse(result.outputJson)).toBe('deleted');
    const event = JSON.parse((stateEvents(native)[0] as any[])[2]);
    expect(event).toMatchObject({ key: 'stage', operation: 'delete' });
    expect(native.persistWorkflowState).toHaveBeenCalledWith(expect.objectContaining({ stateJson: '{}' }));
  });

  it('does not read or rewrite state for workflows that only read', async () => {
    const native = nativeWorker();
    workflow('stateful', async ctx => ctx.get('stage', 'empty'));
    expect((await dispatch(native)).eventType).toBe('run.completed');
    expect(native.persistWorkflowState).not.toHaveBeenCalled();
    expect(stateEvents(native)).toHaveLength(0);
  });
});
