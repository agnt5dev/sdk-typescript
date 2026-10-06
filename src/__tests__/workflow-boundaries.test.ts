import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activationId } from '../activation.js';
import { Worker } from '../worker.js';
import { fn, FunctionRegistry } from '../function.js';
import { workflow, WorkflowRegistry } from '../workflow.js';
import { executeChildWorkflow } from '../workflow-utils.js';
import { invocationRunId } from '../child-workflow.js';

const metadata = { run_id: 'parent', project_id: 'project', dispatch_mode: 'pull', worker_session_id: 'session', lease_id: 'lease', activation_artifact_sha256: Buffer.alloc(32, 1).toString('base64'), activation_definition_version: 'v1' };
function nativeWorker() {
  const attempts = new Map<string, number>();
  const outputs = new Map<string, Uint8Array>();
  return {
    queueEvent: vi.fn(), emitCheckpoint: vi.fn(async () => {}), persistWorkflowState: vi.fn(async () => {}),
    beginActivation: vi.fn(async (request: any) => {
      const id = await activationId(request.projectId, request.runId, request.parentActivationId, request.kind, request.stableKey);
      const attempt = (attempts.get(id) ?? 0) + 1; attempts.set(id, attempt);
      return { kind: outputs.has(id) ? 'REPLAY' : 'EXECUTE', activationId: id, attempt, acceptedJournalOffset: 1,
        fenceToken: [1], replayOutput: outputs.get(id) };
    }),
    completeActivation: vi.fn(async (request: any) => { outputs.set(request.activationId, request.output); return { ...request, acceptedJournalOffset: 2 }; }),
    failActivation: vi.fn(async (request: any) => ({ ...request, status: request.retryable ? 'RETRY_READY' : 'FAILED', acceptedJournalOffset: 2 })),
  };
}
async function dispatch(native: ReturnType<typeof nativeWorker>, extra: Record<string, string> = {}) {
  const worker = new Worker('boundaries', { containProcessErrors: false });
  (worker as any).nativeWorker = native;
  return JSON.parse(await (worker as any).processMessage({ invocationId: 'parent', componentName: 'parent-workflow', componentType: 'workflow', inputJson: '{}', metadata: { ...metadata, ...extra } }));
}
describe('workflow execution boundaries', () => {
  beforeEach(() => { FunctionRegistry.clear(); WorkflowRegistry.clear(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each([false, true])('replays direct function calls (activation=%s)', async activation => {
    let calls = 0;
    const direct = fn('direct').run(async () => ++calls);
    workflow('parent-workflow', async ctx => { const result = await direct(ctx); await ctx.waitForUser('Continue?'); return result; });
    const native = nativeWorker();
    const flags = activation ? { durable_activation_v1: 'true' } : {};
    const paused = await dispatch(native, flags);
    expect(paused.eventType).toBe('workflow.paused');
    const completed = await dispatch(native, { ...flags, ...paused.metadata, user_response: 'yes' });
    expect(completed.eventType).toBe('run.completed'); expect(calls).toBe(1);
  });

  it.each([false, true])('honors nested retry policies (activation=%s)', async activation => {
    const observed: number[] = [];
    const flaky = fn('flaky').retry({ maxAttempts: 3, initialIntervalMs: 0 }).run(async ctx => { observed.push(ctx.attempt); if (observed.length < 3) throw new TypeError('temporary'); return 42; });
    workflow('parent-workflow', async ctx => ctx.step('flaky-step', () => flaky(ctx)));
    const native = nativeWorker();
    const result = await dispatch(native, activation ? { durable_activation_v1: 'true' } : {});
    expect(result.eventType).toBe('run.completed'); expect(observed).toEqual([0, 1, 2]);
    if (activation) {
      expect(native.failActivation.mock.calls.map(([request]) => request.retryable)).toEqual([true, true]);
      expect(new Set(native.beginActivation.mock.calls.filter(([request]) => request.kind === 2).map(([request]) => request.stableKey)).size).toBe(1);
    }
  });

  it.each([false, true])('replays direct streaming functions (activation=%s)', async activation => {
    let calls = 0;
    const direct = fn('streamed').run(async function* () { calls++; yield 'one'; yield 'two'; } as any);
    workflow('parent-workflow', async ctx => {
      const values: unknown[] = [];
      for await (const value of await direct(ctx) as any) values.push(value);
      await ctx.waitForUser('Continue?');
      return values;
    });
    const native = nativeWorker();
    const flags = activation ? { durable_activation_v1: 'true' } : {};
    const paused = await dispatch(native, flags);
    const result = await dispatch(native, { ...flags, ...paused.metadata, user_response: 'yes' });
    expect(JSON.parse(result.outputJson)).toEqual(['one', 'two']);
    expect(calls).toBe(1);
  });

  it.each([false, true])('bounds exhausted function retries (activation=%s)', async activation => {
    let calls = 0;
    const failing = fn('failing').retry({ maxAttempts: 2, initialIntervalMs: 0 }).run(async () => { calls++; throw new TypeError('exhausted'); });
    workflow('parent-workflow', async ctx => failing(ctx));
    const native = nativeWorker();
    const result = await dispatch(native, activation ? { durable_activation_v1: 'true' } : {});
    expect(result).toMatchObject({ eventType: 'run.failed', errorType: 'TypeError', error: 'exhausted' });
    expect(calls).toBe(2);
    if (activation) expect(native.failActivation.mock.calls.filter(([request]) => request.errorCode === 'FUNCTION_FAILED').map(([request]) => request.retryable)).toEqual([true, false]);
  });

  it('rejects an unfinished streaming function when the workflow returns', async () => {
    const streamed = fn('unfinished').run(async function* () { yield 1; yield 2; } as any);
    workflow('parent-workflow', async ctx => { const iterator = (await streamed(ctx) as any)[Symbol.asyncIterator](); await iterator.next(); return 'unfinished'; });
    const result = await dispatch(nativeWorker());
    expect(result).toMatchObject({ eventType: 'run.failed', errorType: 'ConfigurationError' });
    expect(result.error).toContain('Finish or close');
  });

  it('rejects waits inside an unfinished step instead of abandoning its activation', async () => {
    workflow('parent-workflow', async ctx => ctx.step('unsafe', () => ctx.waitForSignal('approval')));
    const result = await dispatch(nativeWorker(), { durable_activation_v1: 'true' });
    expect(result).toMatchObject({ eventType: 'run.failed', errorType: 'ConfigurationError' });
    expect(result.error).toContain('between workflow steps');
  });

  it('pauses, resumes, and preserves completed steps across multiple signals', async () => {
    let calls = 0;
    workflow('parent-workflow', async ctx => { await ctx.step('once', () => ++calls); const first = await ctx.waitForSignal('first'); const second = await ctx.waitForSignal('second'); return { first, second }; });
    const native = nativeWorker();
    const first = await dispatch(native);
    expect(first).toMatchObject({ eventType: 'workflow.paused', metadata: { pause_reason: 'signal', signal_name: 'first' } });
    const second = await dispatch(native, { ...first.metadata, signal_payload: '{"ok":true}' });
    expect(second.metadata.signal_name).toBe('second');
    const result = await dispatch(native, { ...second.metadata, signal_payload: '42' });
    expect(JSON.parse(result.outputJson)).toEqual({ first: { ok: true }, second: 42 });
    expect(calls).toBe(1);
  });

  it('carries the wait timeout to the runtime pause', async () => {
    workflow('parent-workflow', async ctx => ctx.waitForUser('Approve?', { timeoutMs: 1000 }));
    expect((await dispatch(nativeWorker())).metadata.wait_timeout_ms).toBe('1000');
    WorkflowRegistry.clear();
    workflow('parent-workflow', async ctx => ctx.waitForSignal('approval', undefined, { timeoutMs: 500 }));
    expect((await dispatch(nativeWorker())).metadata.wait_timeout_ms).toBe('500');
  });

  it('submits one separate child run and replays its result', async () => {
    workflow('child', async () => { throw new Error('child must be dispatched separately'); });
    workflow('parent-workflow', async ctx => executeChildWorkflow(ctx, 'child', { order: 1 }));
    let childRun = '';
    const fetch = vi.fn(async (url: string, init: any) => {
      if (url.endsWith('/submit')) {
        childRun = invocationRunId('project', init.headers['Idempotency-Key']);
        return new Response(JSON.stringify({ run_id: childRun, status: 'queued' }));
      }
      if (url.includes('/status/')) return new Response(JSON.stringify({ run_id: childRun, status: 'completed' }));
      return new Response(JSON.stringify({ run_id: childRun, status: 'completed', output: { child: true } }));
    });
    vi.stubGlobal('fetch', fetch);
    const native = nativeWorker();
    const flags = { durable_activation_v1: 'true' };
    expect(JSON.parse((await dispatch(native, flags)).outputJson)).toEqual({ child: true });
    expect(JSON.parse((await dispatch(native, flags)).outputJson)).toEqual({ child: true });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/submit'))).toHaveLength(1);
    expect(childRun).not.toBe('parent');
    expect(native.beginActivation.mock.calls[0][0].child.childRunId).toBe(childRun);
  });
});
