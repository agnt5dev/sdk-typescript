import { describe, expect, it } from 'vitest';
import { step } from '../step.js';
import { ContextImpl } from '../context.js';
import { ActivationClient, ActivationKind, activationId, currentActivation } from '../activation.js';
import { ActivationError, ActivationErrorCode } from '../errors.js';
import { fn, FunctionRegistry } from '../function.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

class Journal {
  calls: Array<{ phase: string; request: any }> = [];
  committed = new Map<string, Uint8Array>();
  attempts = new Map<string, number>();
  block?: { phase: string; runId: string };
  entered = gate();
  release = gate();
  loseAck = false;
  error?: { phase: string; value: Error };

  async wait(phase: string, runId: string) {
    if (this.block?.phase === phase && this.block.runId === runId) {
      this.entered.resolve();
      await this.release.promise;
    }
    if (this.error?.phase === phase) throw this.error.value;
  }
  async begin(request: any): Promise<any> {
    this.calls.push({ phase: 'begin', request });
    await this.wait('begin', request.runId);
    const id = await activationId(request.projectId, request.runId, request.parentActivationId, request.kind, request.stableKey);
    const replay = this.committed.has(id);
    const attempt = replay ? this.attempts.get(id)! : (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, attempt);
    return { kind: replay ? 'REPLAY' : 'EXECUTE', activationId: id, attempt,
      fenceToken: new Uint8Array([1]), acceptedJournalOffset: 1n,
      replayOutput: this.committed.get(id) };
  }
  async complete(request: any) {
    this.calls.push({ phase: 'complete', request });
    await this.wait('complete', request.runId);
    this.committed.set(request.activationId, request.output);
    if (this.loseAck) throw new ActivationError(ActivationErrorCode.UnknownOutcome, 'ACK lost');
    return { activationId: request.activationId, attempt: request.attempt, acceptedJournalOffset: 2n };
  }
  async fail(request: any) {
    this.calls.push({ phase: 'fail', request });
    await this.wait('fail', request.runId);
    return { activationId: request.activationId, attempt: request.attempt, acceptedJournalOffset: 2n,
      status: request.retryable ? 'RETRY_READY' : 'FAILED' };
  }
}

function context(journal: Journal, runId = 'run-1', signal?: AbortSignal, client?: ActivationClient) {
  return new ContextImpl(runId, runId, 0, 'research', {
    activationClient: client ?? new ActivationClient(journal), signal,
    metadata: { project_id: 'project-1', component_name: 'research', durable_activation_v1: 'true',
      dispatch_mode: 'pull', pull_completion_lifecycle_v1: 'true',
      worker_session_id: 'session-1', lease_id: 'lease-1', activation_definition_version: 'v1',
      activation_artifact_sha256: '00'.repeat(32), activation_definition_config: '["object",[]]' },
  });
}

const phases = (journal: Journal) => journal.calls.map(call => call.phase);

describe('declared durable steps', () => {
  it('uses only one begin and one complete and is not a standalone function', async () => {
    const journal = new Journal();
    const ctx = context(journal);
    const double = step('declared-double', async (scope, input: { value: number }) => {
      expect(scope.activation).toEqual(currentActivation());
      expect(scope.attempt).toBe(0);
      expect(scope.runId).toBe('run-1');
      return input.value * 2;
    });
    expect(await ctx.step(double, { input: { value: 3 }, key: 'three' })).toBe(6);
    expect(phases(journal)).toEqual(['begin', 'complete']);
    expect(JSON.parse(new TextDecoder().decode(journal.calls[1].request.output))).toBe(6);
    expect(journal.calls[0].request.kind).toBe(ActivationKind.Step);
    expect(journal.calls[0].request.stableKey).toBe('step:declared-double:three');
    expect(FunctionRegistry.get('declared-double')).toBeUndefined();
  });

  it.each(['begin', 'complete'])('waits for the %s ACK before dependent work', async phase => {
    const journal = new Journal();
    journal.block = { phase, runId: 'run-1' };
    const ctx = context(journal);
    const executed: string[] = [];
    const first = step('first', async () => { executed.push('first'); return 7; });
    const second = step('second', async (_ctx, input: number) => { executed.push('second'); return input + 1; });
    let returned = false;
    const run = (async () => {
      const value = await ctx.step(first, { key: 'first' });
      const result = await ctx.step(second, { input: value, key: 'second' });
      returned = true;
      return result;
    })();
    try {
      await journal.entered.promise;
      expect(returned).toBe(false);
      expect(executed).toEqual(phase === 'begin' ? [] : ['first']);
      expect(ctx.checkpointSnapshot()).toEqual({});
      journal.block = undefined;
      journal.release.resolve();
      expect(await run).toBe(8);
    } finally { journal.release.resolve(); await run; }
  });

  it('replays a committed result after losing its ACK without repeating the handler', async () => {
    const journal = new Journal();
    let executions = 0;
    const load = step('load', async () => { executions++; return { saved: 42 }; });
    journal.loseAck = true;
    const original = context(journal);
    await expect(original.step(load, { key: 'load' })).rejects.toMatchObject({ code: ActivationErrorCode.UnknownOutcome });
    expect(original.checkpointSnapshot()).toEqual({});
    journal.loseAck = false;
    expect(await context(journal).step(load, { key: 'load' })).toEqual({ saved: 42 });
    expect(executions).toBe(1);
    expect(phases(journal)).toEqual(['begin', 'complete', 'begin']);
  });

  it.each(['begin', 'complete'])('lets another run proceed while %s is blocked', async phase => {
    const journal = new Journal();
    journal.block = { phase, runId: 'run-1' };
    const client = new ActivationClient(journal);
    const work = step('work', async scope => scope.runId);
    const blocked = context(journal, 'run-1', undefined, client).step(work, { key: 'same' });
    try {
      await journal.entered.promise;
      expect(await context(journal, 'run-2', undefined, client).step(work, { key: 'same' })).toBe('run-2');
    } finally { journal.release.resolve(); await blocked; }
  });

  it.each([10, 100])('isolates %i concurrent runs with the same stable key', async count => {
    const journal = new Journal();
    const client = new ActivationClient(journal);
    const work = step('concurrent', async scope => {
      const activation = scope.activation.activationId;
      await Promise.resolve();
      expect(scope.activation.activationId).toBe(activation);
      return scope.runId;
    });
    const results = await Promise.all(Array.from({ length: count }, (_, i) =>
      context(journal, `run-${i}`, undefined, client).step(work, { key: 'same' })));
    expect(new Set(results).size).toBe(count);
    expect(journal.committed.size).toBe(count);
    expect(journal.calls.filter(call => call.phase === 'begin')).toHaveLength(count);
    expect(journal.calls.filter(call => call.phase === 'complete')).toHaveLength(count);
  });

  it('retries through acknowledged failures using fresh input snapshots', async () => {
    const journal = new Journal();
    const seen: number[][] = [];
    const attempts: number[] = [];
    const work = step('retry', async (scope, input: number[]) => {
      seen.push([...input]); attempts.push(scope.attempt);
      const value = input.pop();
      if (seen.length < 3) throw new Error('retry');
      return value;
    }, { retries: { maxAttempts: 3, initialIntervalMs: 0 } });
    const input = [1, 2];
    expect(await context(journal).step(work, { input, key: 'retry' })).toBe(2);
    expect(input).toEqual([1, 2]);
    expect(seen).toEqual([[1, 2], [1, 2], [1, 2]]);
    expect(attempts).toEqual([0, 1, 2]);
    expect(phases(journal)).toEqual(['begin', 'fail', 'begin', 'fail', 'begin', 'complete']);
  });

  it('waits for failure acknowledgment before exposing the error', async () => {
    const journal = new Journal();
    journal.block = { phase: 'fail', runId: 'run-1' };
    const error = new Error('failed');
    const work = step('fail', async () => { throw error; });
    let returned = false;
    const pending = context(journal).step(work).catch(value => { returned = true; return value; });
    await journal.entered.promise;
    expect(returned).toBe(false);
    journal.release.resolve();
    expect(await pending).toBe(error);
  });

  it.each(['begin', 'complete'])('never memoizes a rejected %s', async phase => {
    const journal = new Journal();
    journal.error = { phase, value: new ActivationError(ActivationErrorCode.StaleAuthority, 'lease lost') };
    const ctx = context(journal);
    const work = step('reject', async () => 7);
    await expect(ctx.step(work)).rejects.toMatchObject({ code: ActivationErrorCode.StaleAuthority });
    expect(ctx.checkpointSnapshot()).toEqual({});
  });

  it.each(['begin', 'complete'])('does not return success after cancellation during %s', async phase => {
    const journal = new Journal();
    journal.block = { phase, runId: 'run-1' };
    const controller = new AbortController();
    const ctx = context(journal, 'run-1', controller.signal);
    let executions = 0;
    const work = step('cancel', async () => { executions++; return 7; });
    const pending = ctx.step(work).catch(error => error);
    await journal.entered.promise;
    controller.abort(new Error('cancelled'));
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    journal.release.resolve();
    expect((await pending).message).toMatch(/cancelled/);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(executions).toBe(phase === 'begin' ? 0 : 1);
    expect(ctx.checkpointSnapshot()).toEqual({});
    expect(journal.calls.filter(call => call.phase === 'fail')).toEqual([]);
  });

  it('requires durable activation support', async () => {
    const work = step('durable-only', async () => 1);
    const ctx = new ContextImpl('inv', 'run', 0, 'test');
    await expect(ctx.step(work)).rejects.toMatchObject({ code: ActivationErrorCode.DurabilityUnavailable });
  });
});

describe('declared step failure and nesting', () => {
  it('records a handler timeout as failure rather than completion', async () => {
    const journal = new Journal();
    const work = step('timeout', async scope => {
      await new Promise<void>(resolve => scope.signal.addEventListener('abort', () => resolve(), { once: true }));
      return 1;
    }, { timeoutMs: 1 });
    await expect(context(journal).step(work)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(phases(journal)).toEqual(['begin', 'fail']);
  });

  it('stops retrying if the failure ACK is uncertain', async () => {
    const journal = new Journal();
    journal.error = { phase: 'fail', value: new ActivationError(ActivationErrorCode.UnknownOutcome, 'failure ACK lost') };
    let attempts = 0;
    const work = step('uncertain', async () => { attempts++; throw new Error('failed'); }, { retries: { maxAttempts: 3 } });
    await expect(context(journal).step(work)).rejects.toMatchObject({ code: ActivationErrorCode.UnknownOutcome });
    expect(attempts).toBe(1);
    expect(phases(journal)).toEqual(['begin', 'fail']);
  });

  it('keeps nested step identities under their admitted parent', async () => {
    const journal = new Journal();
    const ctx = context(journal);
    const child = step('child', async (_ctx, value: number) => value);
    const parent = step('parent', async (scope, value: number) => scope.step(child, { input: value, key: 'child' }));
    expect(await ctx.step(parent, { input: 1, key: 'one' })).toBe(1);
    expect(await ctx.step(parent, { input: 2, key: 'two' })).toBe(2);
    const begins = journal.calls.filter(call => call.phase === 'begin').map(call => call.request);
    expect(begins[1].parentActivationId).toBe(await activationId('project-1', 'run-1', '', ActivationKind.Step, begins[0].stableKey));
    expect(begins[3].parentActivationId).not.toBe(begins[1].parentActivationId);
  });

  it('keeps parallel branches in the same run isolated', async () => {
    const journal = new Journal();
    const ctx = context(journal);
    const work = step('branch', async (scope, value: number) => {
      const active = scope.activation.activationId;
      await Promise.resolve();
      expect(scope.activation.activationId).toBe(active);
      return value;
    });
    expect(await Promise.all(Array.from({ length: 20 }, (_, i) => ctx.step(work, { input: i, key: String(i) })))).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(journal.committed.size).toBe(20);
  });

  it.each([0, -1, 1.5, NaN])('rejects invalid timeout %s', timeoutMs => {
    expect(() => step('bad', async () => 1, { timeoutMs })).toThrow(RangeError);
  });
});

describe('declared step context and timeout regressions', () => {
  it('allows nested functions to override the step attempt during retries', async () => {
    const journal = new Journal();
    const attempts: number[] = [];
    const nested = fn('declared-nested-retry').retry({ maxAttempts: 2, initialIntervalMs: 0 }).run(async (scope, _input: null) => {
      attempts.push(scope.attempt);
      if (scope.attempt === 0) throw new Error('retry nested function');
      return scope.attempt;
    });
    const parent = step('parent', async scope => nested(scope, null));
    expect(await context(journal).step(parent)).toBe(1);
    expect(attempts).toEqual([0, 1]);
  });

  it('exposes a non-retrying nested function attempt independently of its parent retry', async () => {
    const journal = new Journal();
    const nested = fn('declared-nested-attempt').run(async (scope, _input: null) => scope.attempt);
    const parent = step('parent', async scope => {
      if (scope.attempt === 0) throw new Error('retry parent');
      expect(scope.attempt).toBe(1);
      return nested(scope, null);
    }, { retries: { maxAttempts: 2, initialIntervalMs: 0 } });
    expect(await context(journal).step(parent)).toBe(0);
  });

  it('keeps a timed-out handler in flight and never overlaps its retry', async () => {
    const journal = new Journal();
    const client = new ActivationClient(journal);
    const entered = gate(); const release = gate();
    let active = 0; let peak = 0; let calls = 0;
    const work = step('timeout-drain', async () => {
      active++; calls++; peak = Math.max(active, peak); entered.resolve();
      await release.promise;
      active--;
      return 'late';
    }, { timeoutMs: 10, retries: { maxAttempts: 2, initialIntervalMs: 0 } });
    let settled = false;
    const run = context(journal, 'run-1', undefined, client).step(work).finally(() => { settled = true; });
    try {
      await entered.promise;
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      expect(calls).toBe(1); expect(client.inFlight('run-1')).toBe(1);
      expect(phases(journal)).toEqual(['begin']);
      release.resolve();
      expect(await run).toBe('late');
      expect(calls).toBe(2); expect(peak).toBe(1); expect(active).toBe(0);
      expect(phases(journal)).toEqual(['begin', 'fail', 'begin', 'complete']);
    } finally { release.resolve(); await run.catch(() => {}); }
  });

  it('keeps cancelled handler effects tracked until they settle', async () => {
    const journal = new Journal(); const client = new ActivationClient(journal);
    const controller = new AbortController(); const entered = gate(); const release = gate();
    const work = step('cancel-drain', async () => { entered.resolve(); await release.promise; return 1; });
    let settled = false;
    const run = context(journal, 'run-1', controller.signal, client).step(work)
      .catch(error => error).finally(() => { settled = true; });
    await entered.promise; controller.abort();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false); expect(client.inFlight('run-1')).toBe(1);
    release.resolve();
    expect(await run).toMatchObject({ code: ActivationErrorCode.Cancelled });
    expect(client.inFlight('run-1')).toBe(0); expect(phases(journal)).toEqual(['begin']);
  });
});
