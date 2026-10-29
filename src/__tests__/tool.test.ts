import { describe, it, expect, beforeEach } from 'vitest';
import { tool, ToolRegistry } from '../tool.js';
import { ContextImpl } from '../context.js';
import {
  ActivationKind,
  ActivationRecoveryPolicy,
  activationId,
  runWithActivation,
} from '../activation.js';
import type {
  ActivationClient,
  ActivationDecision,
  BeginActivationRequest,
} from '../activation.js';

describe('Tool', () => {
  beforeEach(() => {
    ToolRegistry.clear();
  });

  it('should create and register a tool', () => {
    const myTool = tool(
      'test_tool',
      {
        description: 'A test tool',
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Test input' }
          },
          required: ['input']
        }
      },
      async (ctx, args) => {
        return `Processed: ${args.input}`;
      }
    );

    expect(ToolRegistry.listNames()).toContain('test_tool');
    const registered = ToolRegistry.get('test_tool');
    expect(registered).toBeDefined();
    expect(registered?.name).toBe('test_tool');
  });

  it('should invoke a tool with arguments', async () => {
    const calculator = tool(
      'calculator',
      {
        description: 'Simple calculator',
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'number' },
            b: { type: 'number' }
          },
          required: ['a', 'b']
        }
      },
      async (ctx, args) => {
        return args.a + args.b;
      }
    );

    const ctx = new ContextImpl('inv-1', 'run-1', 0, 'test');
    const result = await calculator(ctx, { a: 10, b: 5 });
    expect(result).toBe(15);
  });

  it('injects eval-only tool faults from runtime metadata', async () => {
    const search = tool(
      'search',
      { description: 'Search' },
      async (_ctx, args: { query: string }) => ({ title: args.query })
    );
    const ctx = new ContextImpl('inv-1', 'run-1', 0, 'test', {
      metadata: {
        agnt5_eval_role: 'target',
        'agnt5.eval.tool_faults': JSON.stringify([
          {
            tool: 'search',
            error_code: 'SIMULATED_TIMEOUT',
            message: 'search timed out',
            times: 1,
          },
        ]),
      },
    });

    await expect(search(ctx, { query: 'first' })).rejects.toThrow(
      'SIMULATED_TIMEOUT: search timed out'
    );
    await expect(search(ctx, { query: 'second' })).resolves.toEqual({
      title: 'second',
    });

    const nonTarget = new ContextImpl('inv-2', 'run-2', 0, 'test', {
      metadata: {
        agnt5_eval_role: 'scorer',
        'agnt5.eval.tool_faults': JSON.stringify([{ tool: 'search' }]),
      },
    });
    await expect(search(nonTarget, { query: 'safe' })).resolves.toEqual({
      title: 'safe',
    });
  });

  it('should get tool schema', () => {
    tool(
      'schema_test',
      {
        description: 'Schema test tool',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Query string' }
          },
          required: ['query']
        }
      },
      async (ctx, args) => args.query
    );

    const registered = ToolRegistry.get('schema_test');
    const schema = registered?.getSchema();

    expect(schema).toBeDefined();
    expect(schema?.name).toBe('schema_test');
    expect(schema?.description).toBe('Schema test tool');
    expect(schema?.input_schema.properties).toHaveProperty('query');
  });

  it('should handle tool errors gracefully', async () => {
    const errorTool = tool(
      'error_tool',
      {
        description: 'Tool that throws error',
        inputSchema: { type: 'object', properties: {}, required: [] }
      },
      async (ctx, args) => {
        throw new Error('Tool error');
      }
    );

    const ctx = new ContextImpl('inv-1', 'run-1', 0, 'test');
    await expect(errorTool(ctx, {})).rejects.toThrow('Tool error');
  });

  it('durably activates provider tool calls and exposes a downstream key', async () => {
    let observedActivation: any;
    tool(
      'charge',
      {
        description: 'Charge once',
        recoveryPolicy: 'idempotent_retry',
      },
      async (ctx, args: { amount: number }) => {
        observedActivation = ctx.activation;
        return { amount: args.amount };
      },
    );
    const registered = ToolRegistry.get('charge')!;
    let capturedRequest: BeginActivationRequest | undefined;
    let capturedOptions: any;
    const client = {
      async run(
        request: BeginActivationRequest,
        execute: () => Promise<unknown>,
        options: any,
      ) {
        capturedRequest = request;
        capturedOptions = options;
        const decision: ActivationDecision = {
          kind: 'EXECUTE',
          activationId: await activationId(
            request.projectId,
            request.runId,
            request.parentActivationId,
            request.kind,
            request.stableKey,
          ),
          attempt: 1,
          acceptedJournalOffset: 7n,
          fenceToken: new Uint8Array([1]),
        };
        await options.onAdmitted(decision);
        return { result: await execute(), receipt: decision };
      },
    };
    const ctx = new ContextImpl('inv-1', 'run-1', 0, 'billing-agent', {
      metadata: {
        durable_activation_v1: 'true',
        project_id: 'project-1',
        component_name: 'billing-agent',
        worker_session_id: 'worker-session-1',
        run_authority: 'run-authority-1',
        lease_authority: 'lease-authority-1',
        activation_definition_version: 'v1',
        activation_artifact_sha256: '00'.repeat(32),
        activation_definition_config: '["object",[]]',
      },
    });
    ctx.setActivationClient(client as unknown as ActivationClient);

    await expect(registered.invoke(ctx, { amount: 42 }, 'provider-call-7', {
      toolCallId: 'provider-call-7',
      iteration: 2,
    })).resolves.toEqual({
      amount: 42,
    });
    expect(capturedRequest?.kind).toBe(ActivationKind.Tool);
    expect(capturedRequest?.stableKey).toBe('tool:charge:provider-call-7');
    expect(capturedRequest?.displayName).toBe('charge');
    expect(JSON.parse(new TextDecoder().decode(capturedRequest?.inputData))).toEqual({
      name: 'charge',
      arguments: { amount: 42 },
      tool_call_id: 'provider-call-7',
      iteration: 2,
    });
    expect(registered.usesDurableActivation(ctx)).toBe(true);
    expect(capturedRequest?.recoveryPolicy).toBe(ActivationRecoveryPolicy.IdempotentRetry);
    expect(capturedOptions.failureErrorCode).toBe('TOOL_FAILED');
    expect(capturedOptions.failureRetryable).toBe(true);
    expect(observedActivation.idempotencyKey).toBe(
      `agnt5:${observedActivation.activationId}`,
    );
    expect(ctx.activation).toBeUndefined();
  });

  it('runs a durable tool call whose arguments have an undefined field', async () => {
    let received: unknown;
    tool('lookup', { description: 'Look up', recoveryPolicy: 'idempotent_retry' },
      async (_ctx, args: { id: string; region?: string }) => { received = args; return 'found'; });
    const registered = ToolRegistry.get('lookup')!;
    let capturedRequest: BeginActivationRequest | undefined;
    const client = {
      async run(request: BeginActivationRequest, execute: () => Promise<unknown>, options: any) {
        capturedRequest = request;
        await options.onAdmitted({ kind: 'EXECUTE', activationId: 'actv1_tool', attempt: 1, acceptedJournalOffset: 7n, fenceToken: new Uint8Array([1]) });
        return { result: await execute(), receipt: {} };
      },
    };
    const ctx = new ContextImpl('inv-1', 'run-1', 0, 'agent', {
      metadata: {
        durable_activation_v1: 'true', project_id: 'project-1', component_name: 'agent',
        worker_session_id: 'worker-session-1', run_authority: 'run-authority-1', lease_authority: 'lease-authority-1',
        activation_definition_version: 'v1', activation_artifact_sha256: '00'.repeat(32), activation_definition_config: '["object",[]]',
      },
    });
    ctx.setActivationClient(client as unknown as ActivationClient);

    await expect(registered.invoke(ctx, { id: 'a-1', region: undefined }, 'call-1')).resolves.toBe('found');
    expect(received).toEqual({ id: 'a-1' });
    expect(Object.keys(received as object)).toEqual(['id']);
    expect(JSON.parse(new TextDecoder().decode(capturedRequest?.inputData)).arguments).toEqual({ id: 'a-1' });
  });

  it('defaults effectful tools to unknown outcome and fails closed without a client', async () => {
    tool('ordinary', { description: 'Ordinary effect' }, async () => 'done');
    const registered = ToolRegistry.get('ordinary')!;
    expect(registered.recoveryPolicy).toBe(ActivationRecoveryPolicy.UnknownOutcome);

    const ctx = new ContextImpl('inv-1', 'run-1', 0, 'ordinary', {
      metadata: { durable_activation_v1: 'true' },
    });
    await expect(registered.invoke(ctx, {})).rejects.toMatchObject({
      code: 'DURABILITY_UNAVAILABLE',
    });
  });
});

describe('Tool confirmation', () => {
  beforeEach(() => {
    ToolRegistry.clear();
  });

  function probe() {
    const calls: string[] = [];
    tool(
      'delete_record',
      { description: 'Delete a record', confirmation: true },
      async (_ctx, args: { recordId: string }) => {
        calls.push(args.recordId);
        return `deleted ${args.recordId}`;
      },
    );
    const deleteRecord = ToolRegistry.get('delete_record')!;
    return { deleteRecord, calls };
  }

  it('pauses for approval before the tool runs', async () => {
    const { deleteRecord, calls } = probe();
    const ctx = new ContextImpl('inv-1', 'run-confirm', 0, 'test', { storage: 'memory' });

    await expect(deleteRecord.invoke(ctx, { recordId: 'r1' })).rejects.toMatchObject({
      name: 'WaitingForUserInputError',
      inputType: 'approval',
    });
    expect(calls).toEqual([]);
  });

  it.each(['approve', 'approved'])('runs once answered %s, and leaves later pauses their own answers', async (answer) => {
    const { deleteRecord, calls } = probe();
    const ctx = new ContextImpl('inv-1', 'run-confirm', 0, 'test', { storage: 'memory' });
    await ctx.setUserResponse(0, answer);
    await ctx.setUserResponse(1, 'next answer');

    await expect(deleteRecord.invoke(ctx, { recordId: 'r1' })).resolves.toBe('deleted r1');
    expect(calls).toEqual(['r1']);
    await expect(ctx.waitForUser('Next?')).resolves.toBe('next answer');
  });

  it('does not run when rejected', async () => {
    const { deleteRecord, calls } = probe();
    const ctx = new ContextImpl('inv-1', 'run-confirm', 0, 'test', { storage: 'memory' });
    await ctx.setUserResponse(0, 'reject');

    const result = await deleteRecord.invoke(ctx, { recordId: 'r1' });

    expect(calls).toEqual([]);
    expect(result).toContain('rejected');
  });

  it('does not run when the arguments changed after approval', async () => {
    const { deleteRecord, calls } = probe();
    const first = new ContextImpl('inv-1', 'run-confirm', 0, 'test', { storage: 'memory' });
    await expect(deleteRecord.invoke(first, { recordId: 'r1' })).rejects.toMatchObject({
      name: 'WaitingForUserInputError',
    });

    // The run resumes with the approval, and the model, asked again, proposes another record.
    const resumed = new ContextImpl('inv-1', 'run-confirm', 0, 'test', {
      storage: 'memory',
      checkpoints: first.checkpointSnapshot(),
    });
    await resumed.setUserResponse(0, 'approve');
    const result = await deleteRecord.invoke(resumed, { recordId: 'r2' });

    expect(calls).toEqual([]);
    expect(result).toContain('differs from the one the user approved');
  });

  it('does not run another tool the model picks after the approval', async () => {
    const { deleteRecord, calls } = probe();
    tool('archive_record', { description: 'Archive a record', confirmation: true },
      async (_ctx, args: { recordId: string }) => `archived ${args.recordId}`);
    const archiveRecord = ToolRegistry.get('archive_record')!;
    const first = new ContextImpl('inv-1', 'run-confirm', 0, 'test', { storage: 'memory' });
    await expect(archiveRecord.invoke(first, { recordId: 'r1' })).rejects.toMatchObject({
      name: 'WaitingForUserInputError',
    });

    const resumed = new ContextImpl('inv-1', 'run-confirm', 0, 'test', {
      storage: 'memory',
      checkpoints: first.checkpointSnapshot(),
    });
    await resumed.setUserResponse(0, 'approve');
    const result = await deleteRecord.invoke(resumed, { recordId: 'r1' });

    expect(calls).toEqual([]);
    expect(result).toContain('differs from the one the user approved');
  });

  it('does not run an approved tool again when a later approval resumes', async () => {
    const { deleteRecord, calls } = probe();
    const charges: string[] = [];
    tool('charge', { description: 'Charge a card', confirmation: true },
      async (_ctx, args: { amount: string }) => { charges.push(args.amount); return `charged ${args.amount}`; });
    const charge = ToolRegistry.get('charge')!;
    const workflow = async (ctx: ContextImpl) => {
      await charge.invoke(ctx, { amount: '10' });
      return deleteRecord.invoke(ctx, { recordId: 'r1' });
    };

    const first = new ContextImpl('inv-1', 'run-confirm', 0, 'test', { storage: 'memory' });
    await expect(workflow(first)).rejects.toMatchObject({ name: 'WaitingForUserInputError' });

    const second = new ContextImpl('inv-1', 'run-confirm', 0, 'test', {
      storage: 'memory',
      checkpoints: first.checkpointSnapshot(),
    });
    await second.setUserResponse(0, 'approve');
    await expect(workflow(second)).rejects.toMatchObject({ name: 'WaitingForUserInputError' });
    expect(charges).toEqual(['10']);

    const third = new ContextImpl('inv-1', 'run-confirm', 0, 'test', {
      storage: 'memory',
      checkpoints: second.checkpointSnapshot(),
    });
    await third.setUserResponse(0, 'approve');
    await third.setUserResponse(1, 'approve');
    await expect(workflow(third)).resolves.toBe('deleted r1');

    expect(charges).toEqual(['10']);
    expect(calls).toEqual(['r1']);
  });

  it('runs on resume when the approved arguments come back in another order', async () => {
    const { deleteRecord, calls } = probe();
    const first = new ContextImpl('inv-1', 'run-confirm', 0, 'test', { storage: 'memory' });
    await expect(deleteRecord.invoke(first, { recordId: 'r1', reason: 'dup' } as any)).rejects.toMatchObject({
      name: 'WaitingForUserInputError',
    });

    const resumed = new ContextImpl('inv-1', 'run-confirm', 0, 'test', {
      storage: 'memory',
      checkpoints: first.checkpointSnapshot(),
    });
    await resumed.setUserResponse(0, 'approve');

    await expect(deleteRecord.invoke(resumed, { reason: 'dup', recordId: 'r1' } as any)).resolves.toBe('deleted r1');
    expect(calls).toEqual(['r1']);
  });

  it('refuses to run inside a step, whose replay would skip the pause', async () => {
    const { deleteRecord, calls } = probe();
    const ctx = new ContextImpl('inv-1', 'run-confirm', 0, 'test', { storage: 'memory' });
    await ctx.setUserResponse(0, 'approve');

    await expect(
      ctx.step('cleanup', () => deleteRecord.invoke(ctx, { recordId: 'r1' })),
    ).rejects.toMatchObject({
      name: 'ConfigurationError',
      message: expect.stringContaining('cannot pause for approval'),
    });
    expect(calls).toEqual([]);
  });

  it('refuses to run inside a delegated agent or step, which cannot pause', async () => {
    const { deleteRecord, calls } = probe();
    const ctx = new ContextImpl('inv-1', 'run-confirm', 0, 'test', { storage: 'memory' });
    await ctx.setUserResponse(0, 'approve');
    const childActivation = {
      kind: 'EXECUTE',
      activationId: 'actv1_child',
      attempt: 1,
      acceptedJournalOffset: 1n,
      fenceToken: new Uint8Array([1]),
    } as ActivationDecision;

    await expect(
      runWithActivation(childActivation, () => deleteRecord.invoke(ctx, { recordId: 'r1' })),
    ).rejects.toMatchObject({
      name: 'ConfigurationError',
      message: expect.stringContaining('cannot pause for approval'),
    });
    expect(calls).toEqual([]);
  });
});
