import { beforeEach, describe, expect, it } from 'vitest';
import { FunctionRegistry, fn } from '../function.js';
import { ToolRegistry, tool } from '../tool.js';
import { event, WorkflowRegistry, workflow } from '../workflow.js';
import { serve } from '../workerless.js';

describe('workerless serve()', () => {
  beforeEach(() => {
    FunctionRegistry.clear();
    WorkflowRegistry.clear();
    ToolRegistry.clear();
  });

  it('serves a workerless manifest from registered workflows', async () => {
    const hello = workflow(
      'hello',
      async (_ctx, input: { name: string }) => ({ message: `hello ${input.name}` }),
      { triggers: [event('hello.requested')] },
    );

    const handler = serve({ serviceName: 'local-workerless', workflows: [hello] });
    const response = await handler.fetch(new Request('http://localhost:8787/.well-known/agnt5'));
    const manifest = await response.json() as any;

    expect(response.status).toBe(200);
    expect(manifest).toMatchObject({
      protocol_version: 'workerless.v1',
      service_name: 'local-workerless',
      components: [
        {
          name: 'hello',
          type: 'workflow',
          component_type: 'workflow',
          triggers: [
            {
              trigger_type: 'event',
              event_name: 'hello.requested',
            },
          ],
        },
      ],
    });
  });

  it('invokes a workflow and returns a completed response', async () => {
    workflow('hello', async (_ctx, input: { name: string }) => ({ message: `hello ${input.name}` }));

    const handler = serve();
    const response = await handler.fetch(new Request('http://localhost:8787/agnt5/invoke', {
      method: 'POST',
      body: JSON.stringify({
        protocol_version: 'workerless.v1',
        run_id: 'run-1',
        component_type: 'workflow',
        component_name: 'hello',
        input: { name: 'Ada' },
      }),
    }));
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 'completed',
      output: { message: 'hello Ada' },
    });
  });

  it('invokes functions and tools by component type', async () => {
    fn('double').run(async (_ctx, input: { value: number }) => ({ value: input.value * 2 }));
    tool('echo', { description: 'Echo input' }, async (_ctx, input: { value: string }) => input);

    const handler = serve();
    const functionResponse = await invoke(handler, 'function', 'double', { value: 4 });
    const toolResponse = await invoke(handler, 'tool', 'echo', { value: 'ok' });

    expect(await functionResponse.json()).toEqual({
      status: 'completed',
      output: { value: 8 },
    });
    expect(await toolResponse.json()).toEqual({
      status: 'completed',
      output: { value: 'ok' },
    });
  });

  it('maps handler errors to failed workerless responses', async () => {
    workflow('boom', async () => {
      throw new Error('nope');
    });

    const handler = serve();
    const response = await invoke(handler, 'workflow', 'boom', {});
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'failed',
      error: {
        code: 'WORKERLESS_HANDLER_ERROR',
        message: 'nope',
      },
    });
  });

  it('returns checkpointed step state and replays it on reinvoke', async () => {
    let fetchCount = 0;
    workflow('research', async (ctx) => {
      const page = await ctx.step('fetch', async () => {
        fetchCount += 1;
        return { title: 'AGNT5' };
      });
      return { page };
    });

    const handler = serve();
    const firstResponse = await invoke(handler, 'workflow', 'research', {});
    const first = await firstResponse.json() as any;

    expect(first).toEqual({
      status: 'completed',
      output: { page: { title: 'AGNT5' } },
      checkpoint: {
        steps: {
          fetch: { title: 'AGNT5' },
        },
      },
    });
    expect(fetchCount).toBe(1);

    const secondResponse = await invoke(handler, 'workflow', 'research', {}, first.checkpoint);
    const second = await secondResponse.json() as any;

    expect(second.output).toEqual({ page: { title: 'AGNT5' } });
    expect(fetchCount).toBe(1);
  });

  it('returns suspended with checkpoint when the workerless budget is exhausted', async () => {
    let fetchCount = 0;
    workflow('research', async (ctx) => {
      const page = await ctx.step('fetch', async () => {
        fetchCount += 1;
        return { title: 'AGNT5' };
      });
      await ctx.yieldIfNeeded();
      return { page };
    });

    const handler = serve();
    const response = await invoke(handler, 'workflow', 'research', {}, undefined, {
      deadline_ms: Date.now() - 1,
      yield_before_timeout_ms: 0,
    });
    const body = await response.json() as any;

    expect(body).toMatchObject({
      status: 'suspended',
      reason: 'budget',
      checkpoint: {
        steps: {
          fetch: { title: 'AGNT5' },
        },
      },
    });
    expect(fetchCount).toBe(1);

    const resumed = await invoke(handler, 'workflow', 'research', {}, body.checkpoint, {
      deadline_ms: Date.now() + 60_000,
      yield_before_timeout_ms: 1000,
    });
    const resumedBody = await resumed.json() as any;

    expect(resumedBody).toMatchObject({
      status: 'completed',
      output: { page: { title: 'AGNT5' } },
    });
    expect(fetchCount).toBe(1);
  });
});

async function invoke(
  handler: ReturnType<typeof serve>,
  componentType: string,
  componentName: string,
  input: unknown,
  checkpoint?: unknown,
  budget?: unknown,
): Promise<Response> {
  return handler.fetch(new Request('http://localhost:8787/agnt5/invoke', {
    method: 'POST',
    body: JSON.stringify({
      protocol_version: 'workerless.v1',
      run_id: 'run-1',
      component_type: componentType,
      component_name: componentName,
      input,
      checkpoint,
      budget,
    }),
  }));
}
