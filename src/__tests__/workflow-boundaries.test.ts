import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activationId } from '../activation.js';
import { Worker } from '../worker.js';
import { fn, FunctionRegistry } from '../function.js';
import { workflow, WorkflowRegistry } from '../workflow.js';
import { executeChildWorkflow, saga, withTimeout } from '../workflow-utils.js';
import { invocationRunId } from '../child-workflow.js';
import { ActivationError, ActivationErrorCode } from '../errors.js';
import { tool } from '../tool.js';

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
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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

  // A retrying function's durable activation hashes its input. An optional
  // field left undefined (the coding-agent template's sandbox_id on its first
  // iteration) failed with INVALID_ARGUMENT before the body ran.
  it.each(['in a step', 'directly'])('runs a retrying function whose input has an undefined field (%s)', async how => {
    const received: unknown[] = [];
    const sync = fn('code_sync').retry({ maxAttempts: 3, initialIntervalMs: 0 })
      .run(async (_ctx, input: { main_code: string; sandbox_id?: string }) => { received.push(input); return 'synced'; });
    workflow('parent-workflow', async ctx => {
      const input = { main_code: 'x', sandbox_id: undefined as string | undefined };
      return how === 'in a step' ? ctx.step('sync-step', () => sync(ctx, input)) : sync(ctx, input);
    });
    const native = nativeWorker();
    const result = await dispatch(native, { durable_activation_v1: 'true' });
    expect(result.eventType).toBe('run.completed');
    expect(JSON.parse(result.outputJson)).toBe('synced');
    // The body runs on the input the activation hashed: the undefined field dropped.
    expect(received).toEqual([{ main_code: 'x' }]);
    expect(Object.keys(received[0] as object)).toEqual(['main_code']);
    const functionBegin = native.beginActivation.mock.calls.map(([request]) => request).find(request => request.kind === 2);
    expect(JSON.parse(new TextDecoder().decode(functionBegin.inputData))).toEqual([{ main_code: 'x' }]);
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

  it.each([false, true])('preserves the exhausted iterator protocol (activation=%s)', async activation => {
    const streamed = fn('iterator-protocol').run(async function* () { yield 1; return 2; } as any);
    workflow('parent-workflow', async ctx => {
      const iterator = (await streamed(ctx) as any)[Symbol.asyncIterator]();
      expect(await iterator.next()).toEqual({ done: false, value: 1 });
      expect(await iterator.next()).toEqual({ done: true, value: 2 });
      expect(await iterator.next(99)).toEqual({ done: true, value: undefined });
      expect(await iterator.return(17)).toEqual({ done: true, value: 17 });
      const error = new TypeError('consumer error');
      await expect(iterator.throw(error)).rejects.toBe(error);
      await ctx.waitForUser('Continue?');
      return 'done';
    });
    const native = nativeWorker();
    const flags = activation ? { durable_activation_v1: 'true' } : {};
    const paused = await dispatch(native, flags);
    expect(paused.eventType).toBe('workflow.paused');
    const resumed = await dispatch(native, { ...flags, ...paused.metadata, user_response: 'yes' });
    expect(JSON.parse(resumed.outputJson)).toBe('done');
  });

  it.each([false, true])('does not retry a stream after exposing its iterator (activation=%s)', async activation => {
    let calls = 0;
    const streamed = fn('failed-stream').retry({ maxAttempts: 3, initialIntervalMs: 0 }).run(async function* () {
      calls++; yield 'partial'; throw new TypeError('stream failed');
    } as any);
    const observed: unknown[] = [];
    workflow('parent-workflow', async ctx => { for await (const chunk of await streamed(ctx) as any) observed.push(chunk); });
    const native = nativeWorker();
    const result = await dispatch(native, activation ? { durable_activation_v1: 'true' } : {});
    expect(result).toMatchObject({ eventType: 'run.failed', errorType: 'TypeError', error: 'stream failed' });
    expect(observed).toEqual(['partial']);
    expect(calls).toBe(1);
    if (activation) expect(native.failActivation.mock.calls.filter(([request]) => request.errorCode === 'FUNCTION_FAILED').map(([request]) => request.retryable)).toEqual([false]);
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

  it.each([false, true])('rejects an incompletely consumed replay before a wait or completion (activation=%s)', async activation => {
    const streamed = fn('replayed-stream').run(async function* () { yield 1; yield 2; } as any);
    let boundary = 'original';
    workflow('parent-workflow', async ctx => {
      const iterator = await streamed(ctx) as any;
      await iterator.next();
      if (boundary === 'original') { await iterator.next(); await iterator.next(); }
      if (boundary !== 'return') await ctx.waitForUser('Continue?');
      return 'done';
    });
    const native = nativeWorker();
    const flags = activation ? { durable_activation_v1: 'true' } : {};
    const paused = await dispatch(native, flags);
    expect(paused.eventType).toBe('workflow.paused');
    for (boundary of ['wait', 'return']) {
      const result = await dispatch(native, { ...flags, ...paused.metadata, user_response: 'yes' });
      expect(result).toMatchObject({ eventType: 'run.failed', errorType: 'ConfigurationError' });
      expect(result.error).toContain('Finish or close');
    }
  });

  it.each([false, true])('preserves the failed saga outcome across dispatches after compensation (activation=%s)', async activation => {
    const reserve = vi.fn(async () => 1);
    const release = vi.fn(async () => {});
    const charge = vi.fn().mockRejectedValueOnce(new Error('payment failed')).mockResolvedValue(2);
    workflow('parent-workflow', async ctx => {
      let outcome = 'success';
      try { await saga(ctx, [[reserve, release], [charge, async () => {}]], { name: 'order' }); }
      catch (error) { outcome = (error as Error).message; }
      await ctx.waitForUser('Continue?');
      return outcome;
    });
    const native = nativeWorker();
    const flags = activation ? { durable_activation_v1: 'true' } : {};
    const paused = await dispatch(native, flags);
    expect(paused.eventType).toBe('workflow.paused');
    const completed = await dispatch(native, { ...flags, ...paused.metadata, user_response: 'yes' });
    expect(completed.eventType).toBe('run.completed');
    expect(JSON.parse(completed.outputJson)).toBe('payment failed');
    expect(reserve).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(charge).toHaveBeenCalledOnce();
  });

  it('rejects waits inside an unfinished step instead of abandoning its activation', async () => {
    workflow('parent-workflow', async ctx => ctx.step('unsafe', () => ctx.waitForSignal('approval')));
    const result = await dispatch(nativeWorker(), { durable_activation_v1: 'true' });
    expect(result).toMatchObject({ eventType: 'run.failed', errorType: 'ConfigurationError' });
    expect(result.error).toContain('between workflow steps');
  });

  it.each(['user', 'signal', 'sleep'])('fails a durable tool activation that attempts a %s wait', async wait => {
    const waitingTool = tool(`wait-${wait}`, { description: 'unsafe tool' }, async ctx => {
      if (wait === 'user') return ctx.waitForUser('Continue?');
      if (wait === 'signal') return ctx.waitForSignal('approval');
      return ctx.sleep(100, 'delay');
    });
    workflow('parent-workflow', async ctx => waitingTool._tool.invoke(ctx, {}));
    const native = nativeWorker();
    const result = await dispatch(native, { durable_activation_v1: 'true' });
    expect(result).toMatchObject({ eventType: 'run.failed', errorType: 'ConfigurationError' });
    expect(native.failActivation).toHaveBeenCalledOnce();
    expect(native.failActivation.mock.calls[0][0].errorCode).toBe('TOOL_FAILED');
    expect(native.completeActivation).not.toHaveBeenCalled();
  });

  it.each([undefined, null, false, { kind: 'undefined', version: 1 }])('preserves nested function output across activation recovery (%s)', async output => {
    const handler = vi.fn(async () => output);
    const nested = fn('nested-output').retry({ maxAttempts: 2, initialIntervalMs: 0 }).run(handler);
    const observed: unknown[] = [];
    workflow('parent-workflow', async ctx => ctx.step('outer', async () => {
      const value = await nested(ctx);
      observed.push(value);
      if (observed.length === 1) throw new ActivationError(ActivationErrorCode.StaleAuthority, 'dispatch lost after nested completion');
      return 'recovered';
    }));
    const native = nativeWorker();
    expect((await dispatch(native, { durable_activation_v1: 'true' })).eventType).toBe('run.failed');
    expect((await dispatch(native, { durable_activation_v1: 'true' })).eventType).toBe('run.completed');
    expect(observed).toEqual([output, output]);
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([false, true])('preserves iterator arguments and rejects a changed next/throw/return argument (activation=%s)', async activation => {
    for (const operation of ['next', 'throw', 'return']) {
      WorkflowRegistry.clear();
      let argument: unknown = operation === 'throw' ? new AggregateError([new TypeError('original')], 'failed') : { value: 'original', optional: undefined };
      const handler = vi.fn(async function* () {
        try { const input = yield 'start'; yield input; }
        catch (error) { yield (error as Error).message; }
      });
      const streamed = fn(`protocol-${operation}`).run(handler as any);
      workflow('parent-workflow', async ctx => {
        const iterator = await streamed(ctx) as any;
        await iterator.next();
        await iterator[operation](argument);
        if (operation !== 'return') await iterator.next();
        await ctx.waitForUser('Continue?');
        return 'done';
      });
      const native = nativeWorker();
      const flags = activation ? { durable_activation_v1: 'true' } : {};
      const paused = await dispatch(native, flags);
      expect(paused.eventType).toBe('workflow.paused');
      const resumed = { ...flags, ...paused.metadata, user_response: 'yes' };
      // Reconstructed Error stacks differ even when their semantic data is unchanged.
      argument = operation === 'throw' ? new AggregateError([new TypeError('original')], 'failed') : { optional: undefined, value: 'original' };
      expect((await dispatch(native, resumed)).eventType).toBe('run.completed');
      argument = operation === 'throw' ? new AggregateError([new TypeError('changed')], 'failed') : { value: 'changed', optional: undefined };
      const result = await dispatch(native, resumed);
      expect(result).toMatchObject({ eventType: 'run.failed', errorType: 'ActivationError' });
      expect(result.error).toContain('NON_DETERMINISTIC_REPLAY');
      expect(handler).toHaveBeenCalledOnce();
    }
  });

  it('cancels the parent while downloading a child output reference', async () => {
    const child = workflow('child', async () => 'unused');
    workflow('parent-workflow', async ctx => child(ctx, {}));
    const worker = new Worker('boundaries', { containProcessErrors: false });
    (worker as any).nativeWorker = nativeWorker();
    let downloading!: () => void;
    const started = new Promise<void>(resolve => { downloading = resolve; });
    let outputSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      if (url.endsWith('/output')) {
        outputSignal = init.signal;
        downloading();
        return new Promise<Response>((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
      }
      return new Response(JSON.stringify({ run_id: 'child', status: 'completed', output_ref: { kind: 'agnt5.object_store.ref.v1', ref: 'output.json' } }));
    }));
    const pending = (worker as any).processMessage({ invocationId: 'parent', componentName: 'parent-workflow', componentType: 'workflow', inputJson: '{}', metadata });
    await started;
    (worker as any).inflight.get('parent').abort(new Error('parent cancelled'));
    const result = JSON.parse(await pending);
    expect(result.eventType).toBe('run.cancelled');
    expect(outputSignal?.aborted).toBe(true);
  });

  it('preserves an undefined child output across replay', async () => {
    const child = workflow('child', async () => undefined);
    const observed: unknown[] = [];
    workflow('parent-workflow', async ctx => {
      observed.push(await child(ctx, {}));
      await ctx.waitForUser('Continue?');
      return 'done';
    });
    let childRun = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      if (url.endsWith('/submit')) childRun = invocationRunId('project', init.headers['Idempotency-Key']);
      return new Response(JSON.stringify({ run_id: childRun, status: 'completed' }));
    }));
    const native = nativeWorker();
    const paused = await dispatch(native, { durable_activation_v1: 'true' });
    expect(paused.eventType).toBe('workflow.paused');
    expect((await dispatch(native, { durable_activation_v1: 'true', ...paused.metadata, user_response: 'yes' })).eventType).toBe('run.completed');
    expect(observed).toEqual([undefined, undefined]);
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

  it('stops polling a child after a join timeout', async () => {
    vi.useFakeTimers();
    workflow('child', async () => 'child');
    workflow('parent-workflow', async ctx => withTimeout(ctx, 'child', {}, 100));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith('/submit') ? { run_id: 'child-run', status: 'queued' } : { run_id: 'child-run', status: 'running' }
    ))));
    const running = dispatch(nativeWorker());
    await vi.advanceTimersByTimeAsync(100);
    // The worker gives detached process errors one turn to surface before
    // committing its outcome; finish those turns after the join expires.
    await vi.runAllTimersAsync();
    await expect(running).resolves.toMatchObject({ eventType: 'run.failed', errorType: 'TimeoutError' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('submits direct workflow calls as separate children and replays their results (activation=%s)', async activation => {
    const child = workflow('child', async () => { throw new Error('child must be dispatched separately'); });
    workflow('parent-workflow', async ctx => {
      const result = await child(ctx, { order: 1 });
      await ctx.waitForUser('Continue?');
      return result;
    });
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
    const flags = activation ? { durable_activation_v1: 'true' } : {};
    const paused = await dispatch(native, flags);
    expect(paused.eventType).toBe('workflow.paused');
    const resumed = { ...flags, ...paused.metadata, user_response: 'yes' };
    expect(JSON.parse((await dispatch(native, resumed)).outputJson)).toEqual({ child: true });
    expect(JSON.parse((await dispatch(native, resumed)).outputJson)).toEqual({ child: true });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/submit'))).toHaveLength(1);
    expect(childRun).not.toBe('parent');
    if (activation) expect(native.beginActivation.mock.calls[0][0].child.childRunId).toBe(childRun);
  });
});
