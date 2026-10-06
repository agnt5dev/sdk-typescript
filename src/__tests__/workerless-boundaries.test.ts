import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextImpl } from '../context.js';
import { runChildWorkflow } from '../child-workflow.js';
import { fn, FunctionRegistry } from '../function.js';
import { workflow, WorkflowRegistry } from '../workflow.js';
import { serve } from '../workerless.js';
import { saga } from '../workflow-utils.js';

async function invoke(handler: ReturnType<typeof serve>, checkpoint?: unknown, metadata?: Record<string, string>) {
  return (await handler.fetch(new Request('http://localhost/agnt5/invoke', {
    method: 'POST', body: JSON.stringify({ run_id: 'parent', component_type: 'workflow', component_name: 'parent', input: {}, checkpoint, metadata }),
  }))).json() as Promise<any>;
}

describe('workerless execution boundaries', () => {
  beforeEach(() => { FunctionRegistry.clear(); WorkflowRegistry.clear(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it.each([false, true])('replays distinct repeated function calls (concurrent=%s)', async concurrent => {
    const calls: number[] = [];
    const transform = fn('transform').run(async (_ctx, value: number) => { calls.push(value); return value * 2; });
    const parent = workflow('parent', async ctx => {
      const output = concurrent ? await Promise.all([transform(ctx, 1), transform(ctx, 2)]) : [await transform(ctx, 1), await transform(ctx, 2)];
      await ctx.waitForUser('Continue?');
      return output;
    });
    const handler = serve({ workflows: [parent], allowUnsigned: true });
    const paused = await invoke(handler);
    expect(paused.status).toBe('suspended');
    const completed = await invoke(handler, paused.checkpoint, { user_response: 'yes', pause_index: '0' });
    expect(completed).toMatchObject({ status: 'completed', output: [2, 4] });
    expect(calls).toEqual([1, 2]);
  });

  it.each([false, true])('submits distinct repeated children and replays their results (concurrent=%s)', async concurrent => {
    const child = workflow('child', async () => { throw new Error('child must be submitted'); });
    const parent = workflow('parent', async ctx => {
      const output = concurrent ? await Promise.all([child(ctx, 1), child(ctx, 2)]) : [await child(ctx, 1), await child(ctx, 2)];
      await ctx.waitForUser('Continue?');
      return output;
    });
    const submitted = new Map<string, number>();
    const fetch = vi.fn(async (url: string, init: any) => {
      if (url.endsWith('/submit')) {
        const key = init.headers['Idempotency-Key'];
        submitted.set(key, JSON.parse(init.body));
        return new Response(JSON.stringify({ run_id: key, status: 'queued' }));
      }
      const key = url.slice(url.lastIndexOf('/') + 1);
      return new Response(JSON.stringify({ run_id: key, status: 'completed', output: submitted.get(key) }));
    });
    vi.stubGlobal('fetch', fetch);
    const handler = serve({ workflows: [parent], allowUnsigned: true });
    const paused = await invoke(handler);
    const completed = await invoke(handler, paused.checkpoint, { user_response: 'yes', pause_index: '0' });
    expect(completed).toMatchObject({ status: 'completed', output: [1, 2] });
    expect([...submitted.values()]).toEqual([1, 2]);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/submit'))).toHaveLength(2);
  });

  it('uses the dispatch tenant for every child request', async () => {
    vi.stubEnv('AGNT5_TENANT_ID', 'ambient-tenant');
    const child = workflow('child', async () => 'unused');
    const parent = workflow('parent', async ctx => child(ctx, {}));
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify({ run_id: 'child', status: 'completed', output: 1 })));
    vi.stubGlobal('fetch', fetch);
    expect(await invoke(serve({ workflows: [parent], allowUnsigned: true }), undefined, { tenant_id: 'dispatch-tenant' })).toMatchObject({ status: 'completed', output: 1 });
    for (const [, init] of fetch.mock.calls as any) expect(init.headers['X-Tenant-ID']).toBe('dispatch-tenant');
  });

  it.each([null, false, { approved: true }])('preserves consumed signals across sequential suspensions (%s)', async firstSignal => {
    const work = vi.fn(async () => 1);
    const parent = workflow('parent', async ctx => {
      await ctx.step('work', work);
      const first = await ctx.waitForSignal('first', 'approval');
      const second = await ctx.waitForSignal('second', 'finish');
      return { first, second };
    });
    const handler = serve({ workflows: [parent], allowUnsigned: true });
    const first = await invoke(handler);
    expect(first).toMatchObject({ status: 'suspended', signal_name: 'first' });
    const second = await invoke(handler, first.checkpoint, { signal_name: 'first', waiting_step: 'approval', signal_payload: JSON.stringify(firstSignal) });
    expect(second).toMatchObject({ status: 'suspended', signal_name: 'second' });
    const completed = await invoke(handler, second.checkpoint, { signal_name: 'second', waiting_step: 'finish', signal_payload: 'true' });
    expect(completed).toMatchObject({ status: 'completed', output: { first: firstSignal, second: true } });
    expect(work).toHaveBeenCalledOnce();
  });

  it('persists a failed saga outcome after rollback through the returned checkpoint', async () => {
    const reserve = vi.fn(async () => 1);
    const release = vi.fn(async () => {});
    const charge = vi.fn().mockRejectedValueOnce(new Error('payment failed')).mockResolvedValue(2);
    const parent = workflow('parent', async ctx => {
      let outcome = 'success';
      try { await saga(ctx, [[reserve, release], [charge, async () => {}]], { name: 'order' }); }
      catch (error) { outcome = (error as Error).message; }
      await ctx.waitForUser('Continue?');
      return outcome;
    });
    const handler = serve({ workflows: [parent], allowUnsigned: true });
    const paused = await invoke(handler);
    expect(paused.status).toBe('suspended');
    const completed = await invoke(handler, paused.checkpoint, { user_response: 'yes', pause_index: '0' });
    expect(completed).toMatchObject({ status: 'completed', output: 'payment failed' });
    expect(reserve).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(charge).toHaveBeenCalledOnce();
  });

  it.each([false, true])('closes a standalone child context (throws=%s)', async throws => {
    const parent = new ContextImpl('parent', 'parent', 0, 'parent', { storage: 'memory' });
    const close = vi.spyOn(ContextImpl.prototype, 'close');
    let child: ContextImpl | undefined;
    const pending = runChildWorkflow(parent, 'child', {}, async ctx => {
      child = ctx as ContextImpl;
      if (throws) throw new Error('child failed');
      return 42;
    });
    if (throws) await expect(pending).rejects.toThrow('child failed');
    else await expect(pending).resolves.toBe(42);
    expect(close).toHaveBeenCalledOnce();
    expect(close.mock.instances[0]).toBe(child);
    expect(close.mock.instances[0]).not.toBe(parent);
  });

  it.each(['return', 'throw'])('closes an unfinished stream when the workflow exits by %s', async mode => {
    const cleanup = vi.fn();
    let signal: AbortSignal | undefined;
    const stream = fn('stream').run(async function* () { try { yield 1; yield 2; } finally { cleanup(); } } as any);
    const parent = workflow('parent', async ctx => {
      signal = ctx.signal;
      const iterator = await stream(ctx) as any;
      await iterator.next();
      if (mode === 'throw') throw new Error('handler failed');
      return 'unfinished';
    });
    const result = await invoke(serve({ workflows: [parent], allowUnsigned: true }));
    expect(result.status).toBe('failed');
    await new Promise(resolve => setImmediate(resolve));
    expect(signal?.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
