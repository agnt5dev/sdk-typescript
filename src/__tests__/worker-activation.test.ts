import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivationError, ActivationErrorCode } from '../errors.js';
import { ActivationKind, activationId } from '../activation.js';
import { Worker } from '../worker.js';
import { WorkflowRegistry, workflow } from '../workflow.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function stepCheckpoints(native: ReturnType<typeof activationNative>) {
  return native.emitCheckpoint.mock.calls.filter(call => call[1].startsWith('workflow.step.'));
}

function activationMetadata(): Record<string, string> {
  return {
    run_id: 'run-1',
    project_id: 'project-1',
    worker_session_id: 'session-1',
    lease_id: 'lease-1',
    run_authority: 'run-authority-1',
    lease_authority: 'lease-authority-1',
    durable_activation_v1: 'true',
    activation_artifact_sha256: btoa(
      String.fromCharCode(...new Uint8Array(32).fill(97)),
    ),
    activation_definition_version: 'v1',
    activation_definition_config: '["object",[]]',
  };
}

function activationNative(overrides: Record<string, unknown> = {}) {
  return {
    queueEvent: vi.fn(),
    emitCheckpoint: vi.fn(),
    emitCheckpointBatch: vi.fn(),
    beginActivation: vi.fn(async (request: any) => ({
      kind: 'EXECUTE',
      activationId: await activationId(
        request.projectId,
        request.runId,
        request.parentActivationId,
        request.kind,
        request.stableKey,
      ),
      attempt: 1,
      acceptedJournalOffset: 11n,
      fenceToken: encoder.encode('fence-1'),
    })),
    completeActivation: vi.fn(async (request: any) => ({
      activationId: request.activationId,
      attempt: request.attempt,
      acceptedJournalOffset: 12n,
      replayed: false,
    })),
    failActivation: vi.fn(async (request: any) => ({
      activationId: request.activationId,
      attempt: request.attempt,
      acceptedJournalOffset: 12n,
      status: 'FAILED',
      replayed: false,
    })),
    ...overrides,
  };
}

async function dispatch(worker: Worker, metadata = activationMetadata()) {
  const response = await (worker as any).processMessage({
    invocationId: 'inv-1',
    componentName: 'durable-workflow',
    componentType: 'workflow',
    inputJson: '{}',
    metadata,
  });
  return JSON.parse(response) as Record<string, any>;
}

describe('managed worker durable activations', () => {
  beforeEach(() => {
    WorkflowRegistry.clear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses activation admission and completion for ctx.step with an explicit key', async () => {
    let executions = 0;
    let observed: { activationId?: string; correlationId?: string } = {};
    workflow('durable-workflow', async ctx => ctx.step('charge', async () => {
      executions += 1;
      observed = {
        activationId: ctx.activation?.activationId,
        correlationId: (ctx as any).getCurrentCorrelationId(),
      };
      return 'charged';
    }, { key: 'order-42' }));
    const native = activationNative();
    const worker = new Worker('durability-test', { serviceVersion: 'v1' });
    (worker as any).nativeWorker = native;

    const response = await dispatch(worker);

    expect(response.eventType).toBe('run.completed');
    expect(executions).toBe(1);
    expect(native.beginActivation).toHaveBeenCalledOnce();
    const begin = native.beginActivation.mock.calls[0][0];
    expect(begin.stableKey).toBe('step:charge:order-42');
    expect(begin.displayName).toBe('charge');
    expect(JSON.parse(decoder.decode(begin.inputData))).toEqual({
      step_name: 'charge',
      step_key: 'step:charge:order-42',
      input: null,
    });
    expect(native.completeActivation).toHaveBeenCalledOnce();
    expect(native.completeActivation.mock.calls[0][0].latencyMs).toBeGreaterThanOrEqual(0);
    // The runtime journals the step boundary from the activation RPCs; the
    // SDK emits no decorative workflow.step.* checkpoint of its own.
    expect(stepCheckpoints(native)).toHaveLength(0);
    // The step body sees the activation as the ambient correlation id so
    // nested function.* events and logs parent to the journal record.
    expect(observed.activationId).toMatch(/^actv1_/);
    expect(observed.correlationId).toBe(observed.activationId);
  });

  it('records a failed step through the activation RPC without a checkpoint', async () => {
    workflow('durable-workflow', async ctx => ctx.step('charge', async () => {
      throw new Error('card declined');
    }));
    const native = activationNative();
    const worker = new Worker('durability-test', { serviceVersion: 'v1' });
    (worker as any).nativeWorker = native;

    const response = await dispatch(worker);

    expect(response.eventType).toBe('run.failed');
    expect(native.failActivation).toHaveBeenCalledOnce();
    expect(native.failActivation.mock.calls[0][0]).toMatchObject({
      errorCode: 'STEP_FAILED',
      latencyMs: expect.any(Number),
    });
    expect(native.completeActivation).not.toHaveBeenCalled();
    expect(stepCheckpoints(native)).toHaveLength(0);
  });

  it('yields durable sleep authority without holding a local timer', async () => {
    workflow('durable-workflow', async ctx => {
      await ctx.sleep(2_500, 'backoff');
      return 'resumed';
    });
    const native = activationNative();
    const worker = new Worker('durability-test', { serviceVersion: 'v1' });
    (worker as any).nativeWorker = native;

    const response = await dispatch(worker, {
      ...activationMetadata(),
      durable_suspension_v1: 'true',
    });

    expect(response.eventType).toBe('workflow.paused');
    expect(response.workerSuspension).toMatchObject({
      attempt: 1,
      timerKey: 'sleep:backoff',
      readyAtMs: 0,
      delayMs: 2_500,
    });
    expect(response.workerSuspension.fenceToken).toEqual(Array.from(encoder.encode('fence-1')));
    expect(native.beginActivation.mock.calls[0][0].kind).toBe(ActivationKind.Timer);
    expect(native.completeActivation).not.toHaveBeenCalled();
    expect(native.failActivation).not.toHaveBeenCalled();
  });

  it('completes only the matching deterministic timer resume', async () => {
    workflow('durable-workflow', async ctx => {
      await ctx.sleep(2_500, 'backoff');
      return 'resumed';
    });
    const native = activationNative();
    const worker = new Worker('durability-test', { serviceVersion: 'v1' });
    (worker as any).nativeWorker = native;
    const timerKey = 'sleep:backoff';
    const timerActivationId = await activationId(
      'project-1',
      'run-1',
      '',
      ActivationKind.Timer,
      timerKey,
    );

    const response = await dispatch(worker, {
      ...activationMetadata(),
      durable_suspension_v1: 'true',
      timer_key: timerKey,
      activation_id: timerActivationId,
    });

    expect(response.eventType).toBe('run.completed');
    expect(JSON.parse(response.outputJson)).toBe('resumed');
    expect(native.beginActivation).not.toHaveBeenCalled();
  });

  it('rejects a mismatched timer resume without completing the sleep', async () => {
    workflow('durable-workflow', async ctx => {
      await ctx.sleep(2_500, 'backoff');
      return 'must-not-complete';
    });
    const native = activationNative();
    const worker = new Worker('durability-test', { serviceVersion: 'v1' });
    (worker as any).nativeWorker = native;

    const response = await dispatch(worker, {
      ...activationMetadata(),
      durable_suspension_v1: 'true',
      timer_key: 'sleep:backoff',
      activation_id: 'wrong-activation',
    });

    expect(response.eventType).toBe('run.failed');
    expect(response.error).toContain('timer resume authority does not match');
    expect(native.beginActivation).not.toHaveBeenCalled();
  });

  it('skips earlier completed sleeps while resuming a later timer', async () => {
    workflow('durable-workflow', async ctx => {
      await ctx.sleep(1_000, 'first');
      await ctx.sleep(1_000, 'second');
      return 'resumed-both';
    });
    const native = activationNative();
    const worker = new Worker('durability-test', { serviceVersion: 'v1' });
    (worker as any).nativeWorker = native;
    const secondActivationId = await activationId(
      'project-1',
      'run-1',
      '',
      ActivationKind.Timer,
      'sleep:second',
    );
    const continuation = Buffer.from(JSON.stringify({
      completed_steps: { 'sleep:first': null },
    })).toString('base64url');

    const response = await dispatch(worker, {
      ...activationMetadata(),
      durable_suspension_v1: 'true',
      timer_key: 'sleep:second',
      activation_id: secondActivationId,
      continuation_b64: continuation,
    });

    expect(response.eventType).toBe('run.completed');
    expect(JSON.parse(response.outputJson)).toBe('resumed-both');
    expect(native.beginActivation).not.toHaveBeenCalled();
  });

  it('propagates execution authority to lifecycle records without leaking secrets', async () => {
    workflow('durable-workflow', async ctx => ctx.step('authority', async () => 'done'));
    const native = activationNative();
    const worker = new Worker('durability-test', { serviceVersion: 'v1' });
    (worker as any).nativeWorker = native;
    const authority = {
      ...activationMetadata(),
      dispatch_mode: 'pull',
      worker_id: 'worker-1',
      lease_attempt: '7',
      workerless_signing_secret: 'must-not-leak',
    };

    await dispatch(worker, authority);

    const expectedAuthority = {
      dispatch_mode: 'pull',
      worker_id: 'worker-1',
      worker_session_id: 'session-1',
      lease_id: 'lease-1',
      lease_attempt: '7',
      run_authority: 'run-authority-1',
      lease_authority: 'lease-authority-1',
    };
    const batchedStarted = native.emitCheckpointBatch.mock.calls
      .flatMap(call => call[0])
      .find((event: any) => event.eventType === 'run.started');
    const directStarted = native.emitCheckpoint.mock.calls.find(
      call => call[1] === 'run.started',
    );
    const startedMetadata = batchedStarted?.metadata ?? directStarted?.[4];
    expect(startedMetadata).toMatchObject(expectedAuthority);
    expect(startedMetadata).not.toHaveProperty('workerless_signing_secret');
    expect(stepCheckpoints(native)).toHaveLength(0);
  });

  it('replays accepted output without executing user code', async () => {
    let executions = 0;
    workflow('durable-workflow', async ctx => ctx.step('charge', async () => {
      executions += 1;
      return 'charged-again';
    }));
    const native = activationNative();
    native.beginActivation.mockImplementation(async (request: any) => ({
      kind: 'REPLAY',
      activationId: await activationId(
        request.projectId,
        request.runId,
        request.parentActivationId,
        ActivationKind.Step,
        request.stableKey,
      ),
      attempt: 1,
      acceptedJournalOffset: 12n,
      replayOutput: encoder.encode('"charged"'),
    }));
    const worker = new Worker('durability-test');
    (worker as any).nativeWorker = native;

    const response = await dispatch(worker);

    expect(response.eventType).toBe('run.completed');
    expect(JSON.parse(response.outputJson)).toBe('charged');
    expect(executions).toBe(0);
    expect(native.completeActivation).not.toHaveBeenCalled();
    // A REPLAY begin appends nothing to the journal and the SDK adds nothing.
    expect(stepCheckpoints(native)).toHaveLength(0);
  });

  it('does not complete the run when completion acknowledgement is lost', async () => {
    let executions = 0;
    workflow('durable-workflow', async ctx => ctx.step('charge', async () => {
      executions += 1;
      return 'charged';
    }));
    const native = activationNative({
      completeActivation: vi.fn(async () => {
        throw new ActivationError(
          ActivationErrorCode.UnknownOutcome,
          'completion acknowledgement was lost',
        );
      }),
    });
    const worker = new Worker('durability-test');
    (worker as any).nativeWorker = native;

    const response = await dispatch(worker);

    expect(executions).toBe(1);
    expect(response.eventType).toBe('run.failed');
    expect(response.error).toContain('completion acknowledgement was lost');
  });

  it('fails before user code when negotiated native activation methods are unavailable', async () => {
    let executions = 0;
    workflow('durable-workflow', async ctx => ctx.step('charge', async () => {
      executions += 1;
      return 'charged';
    }));
    const worker = new Worker('durability-test');
    (worker as any).nativeWorker = { queueEvent: vi.fn(), emitCheckpoint: vi.fn() };

    const response = await dispatch(worker);

    expect(executions).toBe(0);
    expect(response.eventType).toBe('run.failed');
    expect(response.error).toContain('native worker method beginActivation is unavailable');
  });
});
