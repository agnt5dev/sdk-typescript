import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextImpl } from '../context.js';
import { ActivationError, ActivationErrorCode, WaitingForUserInputError } from '../errors.js';
import { saga, withTimeout } from '../workflow-utils.js';
import type { Context } from '../types.js';

describe('workflow helper failure handling', () => {
  const context = () => new ContextImpl('helpers', 'run-helpers', 0, 'helpers', { storage: 'memory' });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('clears the timeout after success or failure', async () => {
    vi.useFakeTimers();
    await expect(withTimeout(context(), async () => 'done', {}, 60_000)).resolves.toBe('done');
    expect(vi.getTimerCount()).toBe(0);
    await expect(withTimeout(context(), async () => { throw new Error('failed'); }, {}, 60_000)).rejects.toThrow('failed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports every failed compensation and still finishes unwinding', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = new Error('payment failed');
    const first = new Error('release inventory failed');
    const second = new Error('release credit failed');
    const compensated: number[] = [];
    let thrown: any;
    try {
      await saga(context(), [
        [async () => 1, async () => { compensated.push(1); throw first; }],
        [async () => 2, async () => { compensated.push(2); throw second; }],
        [async () => { throw original; }, async () => {}],
      ]);
    } catch (error) { thrown = error; }
    expect(compensated).toEqual([2, 1]);
    expect(thrown.errors).toEqual([original, second, first]);
    expect(thrown.cause).toBe(original);
  });

  it('replays completed actions and compensations after another dispatch', async () => {
    const ctx = context();
    const forward = vi.fn(async () => 1);
    const compensate = vi.fn(async () => {});
    const failed = vi.fn(async () => { throw new Error('payment failed'); });
    const steps: Array<[() => Promise<number>, () => Promise<void>]> = [[forward, compensate], [failed, async () => {}]];
    await expect(saga(ctx, steps, { name: 'order' })).rejects.toThrow('payment failed');
    await expect(saga(ctx, steps, { name: 'order' })).rejects.toThrow('payment failed');
    expect(forward).toHaveBeenCalledOnce();
    expect(compensate).toHaveBeenCalledOnce();
  });

  it('keeps a compensated saga failed even when the failed action would recover', async () => {
    const first = context();
    const forward = vi.fn(async () => 1);
    const compensate = vi.fn(async () => {});
    const failed = vi.fn().mockRejectedValueOnce(new TypeError('payment failed')).mockResolvedValue(2);
    const steps: Array<[() => Promise<number>, () => Promise<void>]> = [[forward, compensate], [failed, async () => {}]];
    await expect(saga(first, steps, { name: 'order' })).rejects.toThrow('payment failed');
    const replay = new ContextImpl('helpers', 'run-helpers', 1, 'helpers', { storage: 'memory', checkpoints: JSON.parse(JSON.stringify(first.checkpointSnapshot())) });
    await expect(saga(replay, steps, { name: 'order' })).rejects.toMatchObject({ name: 'TypeError', message: 'payment failed' });
    expect(forward).toHaveBeenCalledOnce();
    expect(compensate).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledOnce();
  });

  it('resumes interrupted rollback without retrying the failed forward action', async () => {
    const first = context();
    const interrupt = new ActivationError(ActivationErrorCode.StaleAuthority, 'lost rollback authority');
    const compensate = vi.fn().mockRejectedValueOnce(interrupt).mockResolvedValue(undefined);
    const failed = vi.fn().mockRejectedValueOnce(new Error('payment failed')).mockResolvedValue(2);
    const steps: Array<[() => Promise<number>, () => Promise<void>]> = [[async () => 1, compensate], [failed, async () => {}]];
    await expect(saga(first, steps, { name: 'order' })).rejects.toBe(interrupt);
    const replay = new ContextImpl('helpers', 'run-helpers', 1, 'helpers', { storage: 'memory', checkpoints: JSON.parse(JSON.stringify(first.checkpointSnapshot())) });
    await expect(saga(replay, steps, { name: 'order' })).rejects.toThrow('payment failed');
    expect(failed).toHaveBeenCalledOnce();
    expect(compensate).toHaveBeenCalledTimes(2);
  });

  it.each(['caller', 'timeout'])('cancels a standalone child through %s cancellation', async mode => {
    const controller = new AbortController();
    const parent = context();
    Object.defineProperty(parent, 'signal', { value: controller.signal });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let childSignal: AbortSignal | undefined;
    const stopped = vi.fn();
    const child = async (ctx: Context) => {
      childSignal = ctx.signal;
      started();
      return new Promise<never>((_, reject) => ctx.signal.addEventListener('abort', () => { stopped(); reject(ctx.signal.reason); }, { once: true }));
    };
    const running = mode === 'timeout' ? withTimeout(parent, child, {}, 20) : withTimeout(parent, child, {}, 60_000);
    const outcome = expect(running).rejects.toMatchObject({ name: mode === 'timeout' ? 'TimeoutError' : 'AbortError' });
    await ready;
    if (mode === 'caller') controller.abort();
    await outcome;
    expect(childSignal?.aborted).toBe(true);
    expect(stopped).toHaveBeenCalledOnce();
  });

  it('does not start a standalone child when the parent is already cancelled', async () => {
    const parent = context();
    const controller = new AbortController(); controller.abort();
    Object.defineProperty(parent, 'signal', { value: controller.signal });
    const child = vi.fn(async () => 1);
    await expect(withTimeout(parent, child, {}, 20)).rejects.toMatchObject({ name: 'AbortError' });
    expect(child).not.toHaveBeenCalled();
  });

  it('clears a standalone child sleep on timeout before later effects run', async () => {
    vi.useFakeTimers();
    const effect = vi.fn();
    const running = withTimeout(context(), async ctx => { await ctx.sleep(60_000); effect(); return 1; }, {}, 20);
    const outcome = expect(running).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(20);
    await outcome;
    expect(effect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('unwinds a pause without starting compensations', async () => {
    const pause = new WaitingForUserInputError({ runId: 'helpers', question: 'Continue?', pauseIndex: 0, stepName: 'approval' });
    const compensate = vi.fn();
    await expect(saga(context(), [[async () => 1, compensate], [async () => { throw pause; }, async () => {}]])).rejects.toBe(pause);
    expect(compensate).not.toHaveBeenCalled();
  });

  it.each([ActivationErrorCode.InvalidArgument, ActivationErrorCode.NonDeterministicReplay, ActivationErrorCode.PayloadConflict])('compensates completed actions for hard activation error %s', async code => {
    const error = new ActivationError(code, 'nested activation failed');
    const compensate = vi.fn(async () => {});
    await expect(saga(context(), [[async () => 1, compensate], [async () => { throw error; }, async () => {}]])).rejects.toBe(error);
    expect(compensate).toHaveBeenCalledOnce();
  });

  it.each([ActivationErrorCode.Contended, ActivationErrorCode.StaleAuthority, ActivationErrorCode.Cancelled, ActivationErrorCode.UnknownOutcome, ActivationErrorCode.RequiredChildUnresolved])('leaves runtime-owned interruption %s uncompensated', async code => {
    const error = new ActivationError(code, 'runtime must resolve this activation');
    const compensate = vi.fn(async () => {});
    await expect(saga(context(), [[async () => 1, compensate], [async () => { throw error; }, async () => {}]])).rejects.toBe(error);
    expect(compensate).not.toHaveBeenCalled();
  });

  it('preserves the original error when compensation succeeds', async () => {
    const original = new Error('payment failed');
    await expect(saga(context(), [[async () => 1, async () => {}], [async () => { throw original; }, async () => {}]])).rejects.toBe(original);
  });
});
