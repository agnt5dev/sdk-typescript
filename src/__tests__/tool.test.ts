import { describe, it, expect, beforeEach } from 'vitest';
import { tool, ToolRegistry } from '../tool.js';
import { ContextImpl } from '../context.js';
import {
  ActivationKind,
  ActivationRecoveryPolicy,
  activationId,
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

    await expect(registered.invoke(ctx, { amount: 42 }, 'provider-call-7')).resolves.toEqual({
      amount: 42,
    });
    expect(capturedRequest?.kind).toBe(ActivationKind.Tool);
    expect(capturedRequest?.stableKey).toBe('tool:charge:provider-call-7');
    expect(capturedRequest?.recoveryPolicy).toBe(ActivationRecoveryPolicy.IdempotentRetry);
    expect(capturedOptions.failureErrorCode).toBe('TOOL_FAILED');
    expect(capturedOptions.failureRetryable).toBe(true);
    expect(observedActivation.idempotencyKey).toBe(
      `agnt5:${observedActivation.activationId}`,
    );
    expect(ctx.activation).toBeUndefined();
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
