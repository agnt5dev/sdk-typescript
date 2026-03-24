import { describe, it, expect, beforeEach } from 'vitest';
import { FunctionRegistry, fn } from '../function';
import { WorkflowRegistry, workflow } from '../workflow';
import { ToolRegistry, tool } from '../tool';
import { ContextImpl } from '../context';

/**
 * Tests for multi-component dispatch logic.
 *
 * The Worker.handleMessage() method uses these registries to route
 * invocations. These tests verify that each component type can be
 * looked up and invoked correctly — the same code paths the worker uses.
 */

describe('Worker component dispatch', () => {
  beforeEach(() => {
    FunctionRegistry.clear();
    WorkflowRegistry.clear();
    ToolRegistry.clear();
  });

  // -----------------------------------------------------------------------
  // Function dispatch
  // -----------------------------------------------------------------------
  it('should dispatch a function by name', async () => {
    fn('add').run(async (ctx, a: number, b: number) => a + b);

    const config = FunctionRegistry.get('add');
    expect(config).toBeDefined();

    const ctx = new ContextImpl('inv-1', 'run-1', 0, 'test');
    const result = await config!.handler(ctx, 3, 4);
    expect(result).toBe(7);
  });

  // -----------------------------------------------------------------------
  // Workflow dispatch
  // -----------------------------------------------------------------------
  it('should dispatch a workflow by name', async () => {
    workflow('process', async (ctx, input: { value: number }) => {
      const doubled = await ctx.step('double', () => input.value * 2);
      return { result: doubled };
    });

    const config = WorkflowRegistry.get('process');
    expect(config).toBeDefined();

    const ctx = new ContextImpl('inv-1', 'run-1', 0, 'test');
    const result = await config!.handler(ctx, { value: 5 });
    expect(result).toEqual({ result: 10 });
  });

  // -----------------------------------------------------------------------
  // Tool dispatch
  // -----------------------------------------------------------------------
  it('should dispatch a tool by name', async () => {
    tool('search', {
      description: 'Search for items',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    }, async (ctx, args: { query: string }) => {
      return [{ title: `Result for: ${args.query}` }];
    });

    const toolInstance = ToolRegistry.get('search');
    expect(toolInstance).toBeDefined();

    const ctx = new ContextImpl('inv-1', 'run-1', 0, 'test');
    const result = await toolInstance!.invoke(ctx, { query: 'hello' });
    expect(result).toEqual([{ title: 'Result for: hello' }]);
  });

  // -----------------------------------------------------------------------
  // Auto-discovery: all registries populated
  // -----------------------------------------------------------------------
  it('should collect components from all registries', () => {
    fn('func-a').run(async () => 'a');
    fn('func-b').run(async () => 'b');
    workflow('wf-a', async (ctx, input: any) => input);
    tool('tool-a', { description: 'Tool A' }, async () => 'tool');

    const components: Array<{ name: string; type: string }> = [];

    for (const [name] of FunctionRegistry.getAll()) {
      components.push({ name, type: 'function' });
    }
    for (const [name] of WorkflowRegistry.all()) {
      components.push({ name, type: 'workflow' });
    }
    for (const [name] of ToolRegistry.all()) {
      components.push({ name, type: 'tool' });
    }

    expect(components).toHaveLength(4);
    expect(components.map(c => c.name).sort()).toEqual(['func-a', 'func-b', 'tool-a', 'wf-a']);
    expect(components.filter(c => c.type === 'function')).toHaveLength(2);
    expect(components.filter(c => c.type === 'workflow')).toHaveLength(1);
    expect(components.filter(c => c.type === 'tool')).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // Missing component handling
  // -----------------------------------------------------------------------
  it('should return undefined for unknown function', () => {
    expect(FunctionRegistry.get('nonexistent')).toBeUndefined();
  });

  it('should return undefined for unknown workflow', () => {
    expect(WorkflowRegistry.get('nonexistent')).toBeUndefined();
  });

  it('should return undefined for unknown tool', () => {
    expect(ToolRegistry.get('nonexistent')).toBeUndefined();
  });
});
