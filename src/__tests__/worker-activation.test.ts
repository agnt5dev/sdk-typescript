import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivationError, ActivationErrorCode } from '../errors.js';
import { ActivationKind, activationId } from '../activation.js';
import { Worker } from '../worker.js';
import { WorkflowRegistry, workflow } from '../workflow.js';

const encoder = new TextEncoder();

function activationMetadata(): Record<string, string> {
  return {
    run_id: 'run-1',
    project_id: 'project-1',
    worker_session_id: 'session-1',
    lease_id: 'lease-1',
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
    beginActivation: vi.fn(async (request: any) => ({
      kind: 'EXECUTE',
      activationId: await activationId(
        request.projectId,
        request.runId,
        request.parentActivationId,
        ActivationKind.Step,
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
    workflow('durable-workflow', async ctx => ctx.step('charge', async () => {
      executions += 1;
      return 'charged';
    }, { key: 'order-42' }));
    const native = activationNative();
    const worker = new Worker('durability-test', { serviceVersion: 'v1' });
    (worker as any).nativeWorker = native;

    const response = await dispatch(worker);

    expect(response.eventType).toBe('run.completed');
    expect(executions).toBe(1);
    expect(native.beginActivation).toHaveBeenCalledOnce();
    expect(native.beginActivation.mock.calls[0][0].stableKey).toBe('step:charge:order-42');
    expect(native.completeActivation).toHaveBeenCalledOnce();
    const lifecycle = native.emitCheckpoint.mock.calls.filter(
      call => call[1].startsWith('workflow.step.'),
    );
    expect(lifecycle.map(call => call[1])).toEqual([
      'workflow.step.started',
      'workflow.step.completed',
    ]);
    expect(lifecycle[1][4]).toMatchObject({
      activation_attempt: '1',
      accepted_journal_offset: '12',
    });
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
    expect(executions).toBe(0);
    expect(native.completeActivation).not.toHaveBeenCalled();
    const completed = native.emitCheckpoint.mock.calls.find(
      call => call[1] === 'workflow.step.completed',
    );
    expect(completed?.[4]).toMatchObject({ cache_hit: 'true' });
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
