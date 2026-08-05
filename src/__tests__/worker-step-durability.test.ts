import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Worker } from '../worker.js';
import { workflow, WorkflowRegistry } from '../workflow.js';

type DispatchMessage = {
  invocationId: string;
  componentName: string;
  componentType: string;
  inputJson: string;
  metadata: Record<string, string>;
};

function workerWithCheckpointFailure(eventTypeToFail: string) {
  const emitCheckpoint = vi.fn(async (_runId: string, eventType: string) => {
    if (eventType === eventTypeToFail) {
      throw new Error(`durability acknowledgement failed: ${eventType}`);
    }
  });
  const nativeWorker = {
    emitCheckpoint,
    queueEvent: vi.fn(),
  };
  const worker = new Worker('durability-test');
  (worker as any).nativeWorker = nativeWorker;

  return { worker, emitCheckpoint };
}

async function dispatchWorkflow(
  worker: Worker,
  metadata: Record<string, string> = {},
): Promise<Record<string, any>> {
  const message: DispatchMessage = {
    invocationId: 'inv-1',
    componentName: 'durable-workflow',
    componentType: 'workflow',
    inputJson: '{}',
    metadata: {
      run_id: 'run-1',
      ...metadata,
    },
  };

  const response = await (worker as any).processMessage(message);
  return JSON.parse(response) as Record<string, any>;
}

describe('Worker durable step checkpoint failures', () => {
  beforeEach(() => {
    WorkflowRegistry.clear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not execute the step when the started checkpoint is not acknowledged', async () => {
    let executions = 0;
    workflow('durable-workflow', async (ctx) => ctx.step('charge', async () => {
      executions += 1;
      return 'charged';
    }));
    const { worker } = workerWithCheckpointFailure('workflow.step.started');

    const response = await dispatchWorkflow(worker);

    expect(executions).toBe(0);
    expect(response.eventType).toBe('run.failed');
    expect(response.error).toBe(
      'durability acknowledgement failed: workflow.step.started',
    );
  });

  it('does not return the step result when the completed checkpoint is not acknowledged', async () => {
    let executions = 0;
    workflow('durable-workflow', async (ctx) => ctx.step('charge', async () => {
      executions += 1;
      return 'charged';
    }));
    const { worker } = workerWithCheckpointFailure('workflow.step.completed');

    const response = await dispatchWorkflow(worker);

    expect(executions).toBe(1);
    expect(response.eventType).toBe('run.failed');
    expect(response.error).toBe(
      'durability acknowledgement failed: workflow.step.completed',
    );
  });

  it('does not return a replayed result when its checkpoint is not acknowledged', async () => {
    let executions = 0;
    workflow('durable-workflow', async (ctx) => ctx.step('charge', async () => {
      executions += 1;
      return 'charged-again';
    }));
    const { worker, emitCheckpoint } = workerWithCheckpointFailure(
      'workflow.step.completed',
    );

    const response = await dispatchWorkflow(worker, {
      completed_steps: JSON.stringify({ 'step:charge:0': 'charged' }),
    });

    expect(executions).toBe(0);
    expect(response.eventType).toBe('run.failed');
    expect(response.error).toBe(
      'durability acknowledgement failed: workflow.step.completed',
    );
    const replayCheckpoint = emitCheckpoint.mock.calls.find(
      (call) => call[1] === 'workflow.step.completed',
    );
    expect(replayCheckpoint?.[4]).toEqual({ cache_hit: 'true' });
  });
});
