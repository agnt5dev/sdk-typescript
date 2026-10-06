import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextImpl } from '../context.js';
import { ActivationError, ActivationErrorCode, WaitingForUserInputError } from '../errors.js';
import { saga, withTimeout } from '../workflow-utils.js';

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
