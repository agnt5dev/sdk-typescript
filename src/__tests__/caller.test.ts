import { describe, it, expect, beforeEach, vi } from 'vitest';

/** ctx.caller: who called a run through a hosted MCP server (AGNT5-1569). */

vi.mock('#native-loader', () => ({
  getLoadedNativeBindings: () => null,
  tryLoadNativeBindings: () => null,
  loadNativeBindings: () => ({}),
}));

const { Worker } = await import('../worker.js');
const { FunctionRegistry, fn } = await import('../function.js');
const { WorkflowRegistry } = await import('../workflow-registry.js');
const { workflow } = await import('../workflow.js');
const { ContextImpl } = await import('../context.js');
const { WorkerlessContext } = await import('../workerless-context.js');
const { callerFromMetadata } = await import('../caller.js');

const MCP_METADATA: Record<string, string> = {
  trigger_type: 'mcp',
  'mcp.server': 'support',
  'mcp.tool': 'lookup_order',
  'mcp.subject': 'user_123',
  'mcp.auth_method': 'oauth',
  'mcp.client': 'claude-desktop',
  project_id: 'proj_1',
};

const EXPECTED = {
  server: 'support',
  tool: 'lookup_order',
  subject: 'user_123',
  authMethod: 'oauth',
  client: 'claude-desktop',
};

describe('callerFromMetadata', () => {
  it('reads the caller from MCP dispatch metadata', () => {
    expect(callerFromMetadata(MCP_METADATA)).toEqual(EXPECTED);
  });

  it('reads an API key caller', () => {
    const caller = callerFromMetadata({
      ...MCP_METADATA,
      'mcp.subject': 'service_key:key_9',
      'mcp.auth_method': 'api_key',
      'mcp.client': 'curl/8.0',
    });
    expect(caller).toEqual({ ...EXPECTED, subject: 'service_key:key_9', authMethod: 'api_key', client: 'curl/8.0' });
  });

  it.each([
    [undefined],
    [{}],
    [{ project_id: 'proj_1' }],
    [{ trigger_type: 'cron', 'mcp.server': 'support' }],
    // trigger_type alone is not reserved; mcp.* is, so it must be there.
    [{ trigger_type: 'mcp' }],
    [{ ...MCP_METADATA, trigger_type: 'api' }],
  ])('is undefined when the run was not started by MCP (%j)', metadata => {
    expect(callerFromMetadata(metadata as Record<string, string> | undefined)).toBeUndefined();
  });

  it('is frozen and carries only the caller fields', () => {
    const caller = callerFromMetadata(MCP_METADATA)!;
    expect(Object.isFrozen(caller)).toBe(true);
    expect(Object.keys(caller).sort()).toEqual(['authMethod', 'client', 'server', 'subject', 'tool']);
  });
});

describe('ctx.caller', () => {
  it('is set on contexts built from MCP dispatch metadata', () => {
    expect(new ContextImpl('inv', 'run', 0, 'svc', { metadata: MCP_METADATA }).caller).toEqual(EXPECTED);
    expect(new WorkerlessContext('inv', 'run', 0, 'svc', { metadata: MCP_METADATA }).caller).toEqual(EXPECTED);
  });

  it('is undefined without MCP metadata', () => {
    expect(new ContextImpl('inv', 'run', 0, 'svc').caller).toBeUndefined();
    expect(new WorkerlessContext('inv', 'run', 0, 'svc', { metadata: { trigger_type: 'cron' } }).caller)
      .toBeUndefined();
  });

  describe('on a dispatched run', () => {
    beforeEach(() => {
      FunctionRegistry.clear();
      WorkflowRegistry.clear();
    });

    function dispatch(componentName: string, componentType: string, metadata: Record<string, string>) {
      const worker = new Worker('mcp-caller', { serviceVersion: '0.1.0' });
      return (worker as any).processMessage({
        invocationId: 'run-mcp',
        componentName,
        componentType,
        inputJson: '{}',
        metadata: { run_id: 'run-mcp', ...metadata },
      });
    }

    it('a function sees the caller', async () => {
      const seen: unknown[] = [];
      fn('lookup_order').run(async ctx => {
        seen.push(ctx.caller);
        return { ok: true };
      });
      await dispatch('lookup_order', 'function', MCP_METADATA);
      expect(seen).toEqual([EXPECTED]);
    });

    it('a workflow sees the caller', async () => {
      const seen: unknown[] = [];
      workflow('triage', async ctx => {
        seen.push(ctx.caller);
        return { ok: true };
      });
      await dispatch('triage', 'workflow', MCP_METADATA);
      expect(seen).toEqual([EXPECTED]);
    });

    it('a run started another way has no caller', async () => {
      const seen: unknown[] = [];
      fn('lookup_order').run(async ctx => {
        seen.push(ctx.caller);
        return { ok: true };
      });
      await dispatch('lookup_order', 'function', { trigger_type: 'cron' });
      expect(seen).toEqual([undefined]);
    });
  });
});
