import { describe, it, expect } from 'vitest';
import { ContextImpl } from '../context';
import {
  ActivationClient,
  ActivationDecision,
  ActivationTransport,
  BeginActivationRequest,
  activationId,
} from '../activation.js';
import { ActivationError, ActivationErrorCode } from '../errors.js';

class ContextActivationTransport implements ActivationTransport {
  beginRequests: BeginActivationRequest[] = [];
  completeRequests: Parameters<ActivationTransport['complete']>[0][] = [];
  decision?: ActivationDecision;
  completeError?: Error;

  async begin(request: BeginActivationRequest) {
    this.beginRequests.push(request);
    return this.decision || {
      kind: 'EXECUTE' as const,
      activationId: await activationId(
        request.projectId,
        request.runId,
        request.parentActivationId,
        request.kind,
        request.stableKey,
      ),
      attempt: 1,
      acceptedJournalOffset: 11n,
      fenceToken: new TextEncoder().encode('fence-1'),
    };
  }

  async complete(request: Parameters<ActivationTransport['complete']>[0]) {
    this.completeRequests.push(request);
    if (this.completeError) throw this.completeError;
    return {
      activationId: request.activationId,
      attempt: request.attempt,
      acceptedJournalOffset: 12n,
    };
  }

  async fail(request: Parameters<ActivationTransport['fail']>[0]) {
    return {
      activationId: request.activationId,
      attempt: request.attempt,
      acceptedJournalOffset: 12n,
      status: 'FAILED',
    };
  }
}

function activationContext(transport: ContextActivationTransport): ContextImpl {
  return new ContextImpl('inv-1', 'run-1', 0, 'workflow', {
    storage: 'memory',
    activationClient: new ActivationClient(transport),
    metadata: {
      project_id: 'project-1',
      worker_session_id: 'session-1',
      lease_id: 'lease-1',
      component_name: 'workflow',
      activation_artifact_sha256: btoa(String.fromCharCode(...new Uint8Array(32).fill(97))),
      activation_definition_version: 'v1',
      activation_definition_config: '["object",[]]',
    },
  });
}

describe('Context', () => {
  it('should create context with metadata', () => {
    const ctx = new ContextImpl('inv-123', 'run-456', 2, 'my-service', { storage: 'memory' });

    expect(ctx.invocationId).toBe('inv-123');
    expect(ctx.runId).toBe('run-456');
    expect(ctx.attempt).toBe(2);
    expect(ctx.serviceName).toBe('my-service');
  });

  it('should manage state', async () => {
    const ctx = new ContextImpl('inv-1', 'run-1', 0, 'test', { storage: 'memory' });

    // Set and get
    await ctx.set('key1', 'value1');
    expect(await ctx.get('key1')).toBe('value1');

    // Get with default
    expect(await ctx.get('missing', 'default')).toBe('default');

    // Delete
    await ctx.delete('key1');
    expect(await ctx.get('key1')).toBeUndefined();
  });

  it('should checkpoint steps', async () => {
    const ctx = new ContextImpl('inv-1', 'run-1', 0, 'test', { storage: 'memory' });

    let executionCount = 0;
    const expensiveOp = () => {
      executionCount++;
      return 'result';
    };

    // First execution
    const result1 = await ctx.step('step1', expensiveOp);
    expect(result1).toBe('result');
    expect(executionCount).toBe(1);

    // Second execution (should use checkpoint)
    const result2 = await ctx.step('step1', expensiveOp);
    expect(result2).toBe('result');
    expect(executionCount).toBe(1); // Should not execute again
  });

  it('should provide logger', () => {
    const ctx = new ContextImpl('inv-1', 'run-1', 0, 'test', { storage: 'memory' });

    expect(ctx.logger).toBeDefined();
    expect(typeof ctx.logger.info).toBe('function');
    expect(typeof ctx.logger.error).toBe('function');
    expect(typeof ctx.logger.warn).toBe('function');
    expect(typeof ctx.logger.debug).toBe('function');
  });

  it('routes steps through accepted activations and supports explicit keys', async () => {
    const transport = new ContextActivationTransport();
    const ctx = activationContext(transport);
    let executions = 0;

    const result = await ctx.step('load', async () => {
      executions += 1;
      expect(ctx.checkpointSnapshot()).not.toHaveProperty('step:load:item-42');
      return { value: 42 };
    }, { key: 'item-42' });

    expect(result).toEqual({ value: 42 });
    expect(executions).toBe(1);
    expect(transport.beginRequests[0].stableKey).toBe('step:load:item-42');
    expect(ctx.checkpointSnapshot()).toHaveProperty('step:load:item-42');
  });

  it('does not memoize or return when activation completion acknowledgement is lost', async () => {
    const transport = new ContextActivationTransport();
    transport.completeError = new ActivationError(
      ActivationErrorCode.UnknownOutcome,
      'completion acknowledgement was lost',
    );
    const ctx = activationContext(transport);

    await expect(ctx.step('load', async () => 'value')).rejects.toMatchObject({
      code: ActivationErrorCode.UnknownOutcome,
    });
    expect(ctx.checkpointSnapshot()).not.toHaveProperty('step:load:0');
  });
});
