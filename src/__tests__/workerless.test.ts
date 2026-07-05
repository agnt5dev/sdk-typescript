import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, AgentRegistry } from '../agent.js';
import type { GenerateRequest, GenerateResponse } from '../agent.js';
import { FunctionRegistry, fn } from '../function.js';
import { ToolRegistry, tool } from '../tool.js';
import { event, WorkflowRegistry, workflow } from '../workflow.js';
import { sleep } from '../workflow-utils.js';
import { serve } from '../workerless.js';

describe('workerless serve()', () => {
  beforeEach(() => {
    FunctionRegistry.clear();
    WorkflowRegistry.clear();
    ToolRegistry.clear();
    AgentRegistry.clear();
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

  it('emits workerless flow-control policies in the manifest', async () => {
    workflow(
      'triage',
      async (_ctx, input: { ticket_id: string }) => ({ ticket_id: input.ticket_id }),
      {
        flowControl: {
          retries: { maxAttempts: 3, initialIntervalMs: 500, backoff: 'exponential' },
          concurrency: { limit: 2, scope: 'component', keyExpression: 'input.account_id' },
          rateLimit: { limit: 10, periodMs: 1000 },
          priority: { level: 'normal' },
          idempotency: { keyExpression: 'input.ticket_id', ttlMs: 60000 },
        },
        priority: 2,
        maxConcurrency: 2,
      },
    );
    fn('expensive')
      .retry({ maxAttempts: 4, initialIntervalMs: 250 })
      .maxConcurrency(1)
      .run(async () => ({ ok: true }));

    const handler = serve();
    const response = await handler.fetch(new Request('http://localhost:8787/.well-known/agnt5'));
    const manifest = await response.json() as any;
    const triage = manifest.components.find((component: any) => component.name === 'triage');
    const expensive = manifest.components.find((component: any) => component.name === 'expensive');

    expect(triage).toMatchObject({
      name: 'triage',
      type: 'workflow',
      priority: 2,
      max_concurrency: 2,
      flow_control: {
        retries: { max_attempts: 3, initial_interval_ms: 500, backoff: 'exponential' },
        concurrency: { limit: 2, scope: 'component', key_expression: 'input.account_id' },
        rate_limit: { limit: 10, period_ms: 1000 },
        priority: { level: 'normal' },
        idempotency: { key_expression: 'input.ticket_id', ttl_ms: 60000 },
      },
    });
    expect(expensive).toMatchObject({
      name: 'expensive',
      type: 'function',
      max_concurrency: 1,
      flow_control: {
        retries: { max_attempts: 4, initial_interval_ms: 250 },
      },
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

  it('returns 503 for protocol routes when disabled by option', async () => {
    workflow('hello', async (_ctx, input: { name: string }) => ({ message: `hello ${input.name}` }));
    const handler = serve({ enabled: false });

    const manifestResponse = await handler.fetch(new Request('http://localhost:8787/.well-known/agnt5'));
    const invokeResponse = await handler.fetch(new Request('http://localhost:8787/agnt5/invoke', {
      method: 'POST',
      body: JSON.stringify({
        protocol_version: 'workerless.v1',
        run_id: 'run-1',
        component_type: 'workflow',
        component_name: 'hello',
        input: { name: 'Ada' },
      }),
    }));

    expect(manifestResponse.status).toBe(503);
    expect(await manifestResponse.json()).toMatchObject({
      status: 'failed',
      error: { code: 'WORKERLESS_DISABLED' },
    });
    expect(invokeResponse.status).toBe(503);
    expect(await invokeResponse.json()).toMatchObject({
      status: 'failed',
      error: { code: 'WORKERLESS_DISABLED' },
    });
  });

  it('returns 503 for protocol routes when disabled by runtime env', async () => {
    const handler = serve<{ AGNT5_SERVERLESS_ENABLED?: string }>();

    const response = await handler.fetch(
      new Request('http://localhost:8787/.well-known/agnt5'),
      { AGNT5_SERVERLESS_ENABLED: 'false' },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: 'failed',
      error: { code: 'WORKERLESS_DISABLED' },
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

  it('serves and invokes registered agents with checkpointed session history', async () => {
    new Agent({
      name: 'support_agent',
      modelName: 'test-model',
      instructions: 'Answer briefly.',
      model: {
        async generate(request: GenerateRequest): Promise<GenerateResponse> {
          const userMessages = request.messages
            .filter((message) => message.role === 'user')
            .map((message) => message.content)
            .join('|');
          return { text: `seen:${userMessages}` };
        },
      },
    });

    const handler = serve();
    const manifestResponse = await handler.fetch(new Request('http://localhost:8787/.well-known/agnt5'));
    const manifest = await manifestResponse.json() as any;

    expect(manifest.components).toContainEqual({
      name: 'support_agent',
      type: 'agent',
      component_type: 'agent',
      metadata: { model: 'test-model' },
    });

    const firstResponse = await invoke(
      handler,
      'agent',
      'support_agent',
      { message: 'hello', session_id: 'session-1' },
    );
    const first = await firstResponse.json() as any;

    expect(firstResponse.status).toBe(200);
    expect(first.output).toBe('seen:hello');
    expect(first.checkpoint.agent_sessions['session-1'].messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'seen:hello' },
    ]);
    expect(first.events.some((event: any) => event.event_type === 'agent.started')).toBe(true);
    expect(first.events).toContainEqual(expect.objectContaining({
      event_type: 'session.created',
      metadata: expect.objectContaining({
        session_id: 'session-1',
        agent_name: 'support_agent',
        session_type: 'agent',
      }),
    }));

    const secondResponse = await invoke(
      handler,
      'agent',
      'support_agent',
      { message: 'again' },
      first.checkpoint,
      undefined,
      { session_id: 'session-1' },
    );
    const second = await secondResponse.json() as any;

    expect(secondResponse.status).toBe(200);
    expect(second.output).toBe('seen:hello|again');
    expect(second.checkpoint.agent_sessions['session-1'].messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'seen:hello' },
      { role: 'user', content: 'again' },
      { role: 'assistant', content: 'seen:hello|again' },
    ]);
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

  it('warns when a resumed run executes a new step before using existing checkpoints', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      workflow('research', async (ctx) => {
        const page = await ctx.step('fetch_v2', async () => ({ title: 'new' }));
        return { page };
      });

      const handler = serve();
      const response = await invoke(handler, 'workflow', 'research', {}, {
        steps: {
          fetch: { title: 'old' },
        },
      });
      const body = await response.json() as any;

      expect(response.status).toBe(200);
      expect(body.output).toEqual({ page: { title: 'new' } });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('changing ctx.step names can re-execute durable work'),
        expect.objectContaining({
          step_name: 'fetch_v2',
          checkpoint_key: 'step:fetch_v2',
          unused_checkpoint_count: 1,
          unused_checkpoint_keys: ['step:fetch'],
        }),
      );
    } finally {
      warn.mockRestore();
    }
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

  it('returns timer suspension with ready_at_ms and resumes after sleep is due', async () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    let fetchCount = 0;
    let afterSleepCount = 0;

    try {
      workflow('delayed', async (ctx) => {
        const page = await ctx.step('fetch', async () => {
          fetchCount += 1;
          return { title: 'AGNT5' };
        });
        await sleep(ctx, 1_500, 'wait');
        afterSleepCount += 1;
        return { page, afterSleepCount };
      });

      const handler = serve();
      const firstResponse = await invoke(handler, 'workflow', 'delayed', {});
      const first = await firstResponse.json() as any;

      expect(first).toMatchObject({
        status: 'suspended',
        reason: 'timer',
        ready_at_ms: 2_500,
        timer_key: 'wait',
        checkpoint: {
          steps: {
            fetch: { title: 'AGNT5' },
            wait: 1_000,
          },
        },
      });
      expect(fetchCount).toBe(1);
      expect(afterSleepCount).toBe(0);

      now = 2_499;
      const earlyResponse = await invoke(handler, 'workflow', 'delayed', {}, first.checkpoint);
      const early = await earlyResponse.json() as any;
      expect(early).toMatchObject({
        status: 'suspended',
        reason: 'timer',
        ready_at_ms: 2_500,
        timer_key: 'wait',
      });
      expect(fetchCount).toBe(1);
      expect(afterSleepCount).toBe(0);

      now = 2_500;
      const resumedResponse = await invoke(handler, 'workflow', 'delayed', {}, first.checkpoint);
      const resumed = await resumedResponse.json() as any;

      expect(resumed).toMatchObject({
        status: 'completed',
        output: {
          page: { title: 'AGNT5' },
          afterSleepCount: 1,
        },
      });
      expect(fetchCount).toBe(1);
      expect(afterSleepCount).toBe(1);
    } finally {
      Date.now = originalNow;
    }
  });

  it('returns user-input suspension and resumes from metadata response', async () => {
    let fetchCount = 0;
    workflow('review', async (ctx) => {
      const draft = await ctx.step('draft', async () => {
        fetchCount += 1;
        return { title: 'AGNT5' };
      });
      const reviewer = await ctx.waitForUser('Who approved this?', {
        inputType: 'text',
        skippable: true,
      });
      return { draft, reviewer };
    });

    const handler = serve();
    const firstResponse = await invoke(handler, 'workflow', 'review', {});
    const first = await firstResponse.json() as any;

    expect(first).toMatchObject({
      status: 'suspended',
      reason: 'user_input_required',
      pause_index: 0,
      step_name: 'wait_for_user_0',
      question: 'Who approved this?',
      input_type: 'text',
      skippable: true,
      checkpoint: {
        steps: {
          draft: { title: 'AGNT5' },
        },
      },
    });
    expect(fetchCount).toBe(1);

    const resumedResponse = await invoke(
      handler,
      'workflow',
      'review',
      {},
      first.checkpoint,
      undefined,
      {
        pause_index: String(first.pause_index),
        user_response: 'Ada',
      },
    );
    const resumed = await resumedResponse.json() as any;

    expect(resumed).toMatchObject({
      status: 'completed',
      output: {
        draft: { title: 'AGNT5' },
        reviewer: 'Ada',
      },
    });
    expect(fetchCount).toBe(1);
  });

  it('returns signal suspension and resumes from signal payload metadata', async () => {
    workflow('approval-signal', async (ctx) => {
      const signal = await ctx.waitForSignal<{ approved: boolean }>('approval_received', 'approval_gate');
      return { approved: signal.approved };
    });

    const handler = serve();
    const firstResponse = await invoke(handler, 'workflow', 'approval-signal', {});
    const first = await firstResponse.json() as any;

    expect(first).toMatchObject({
      status: 'suspended',
      reason: 'signal',
      signal_name: 'approval_received',
      waiting_step: 'approval_gate',
    });

    const resumedResponse = await invoke(
      handler,
      'workflow',
      'approval-signal',
      {},
      first.checkpoint,
      undefined,
      {
        signal_name: 'approval_received',
        waiting_step: 'approval_gate',
        signal_payload: JSON.stringify({ approved: true }),
      },
    );
    const resumed = await resumedResponse.json() as any;

    expect(resumed).toEqual({
      status: 'completed',
      output: { approved: true },
    });
  });

  it('returns emitted stream events on suspension and after resume without replay duplicates', async () => {
    workflow('streaming-review', async (ctx) => {
      await ctx.step('draft', async () => {
        await ctx.emit({
          eventType: 'output.delta',
          data: { chunk: 'draft ready' },
          metadata: { phase: 'draft' },
          correlationId: 'cid-draft',
          timestampNs: 1_000,
        });
        return { title: 'AGNT5' };
      });
      const signal = await ctx.waitForSignal<{ approved: boolean }>('approval_received', 'approval_gate');
      await ctx.emit({
        event_type: 'output.delta',
        data: { chunk: signal.approved ? 'approved' : 'rejected' },
        metadata: { phase: 'approval' },
        correlation_id: 'cid-approval',
        timestamp_ns: 2_000,
      });
      return { approved: signal.approved };
    });

    const handler = serve();
    const firstResponse = await invoke(handler, 'workflow', 'streaming-review', {});
    const first = await firstResponse.json() as any;

    expect(first).toMatchObject({
      status: 'suspended',
      reason: 'signal',
      events: [
        {
          event_type: 'output.delta',
          data: { chunk: 'draft ready' },
          metadata: { phase: 'draft' },
          correlation_id: 'cid-draft',
          timestamp_ns: 1_000,
        },
      ],
      checkpoint: {
        steps: {
          draft: { title: 'AGNT5' },
        },
      },
    });

    const resumedResponse = await invoke(
      handler,
      'workflow',
      'streaming-review',
      {},
      first.checkpoint,
      undefined,
      {
        signal_name: 'approval_received',
        waiting_step: 'approval_gate',
        signal_payload: JSON.stringify({ approved: true }),
      },
    );
    const resumed = await resumedResponse.json() as any;

    expect(resumed).toMatchObject({
      status: 'completed',
      output: { approved: true },
      events: [
        {
          event_type: 'output.delta',
          data: { chunk: 'approved' },
          metadata: { phase: 'approval' },
          correlation_id: 'cid-approval',
          timestamp_ns: 2_000,
        },
      ],
    });
  });

  it('verifies signed workerless invoke requests when configured', async () => {
    workflow('hello', async (_ctx, input: { name: string }) => ({ message: `hello ${input.name}` }));

    const handler = serve({ signingSecret: 'test-signing-secret-123' });
    const body = JSON.stringify({
      protocol_version: 'workerless.v1',
      run_id: 'run-1',
      component_type: 'workflow',
      component_name: 'hello',
      input: { name: 'Ada' },
    });
    const headers = await signedHeaders('test-signing-secret-123', 'run-1:0', body);
    const response = await handler.fetch(new Request('http://localhost:8787/agnt5/invoke', {
      method: 'POST',
      headers,
      body,
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'completed',
      output: { message: 'hello Ada' },
    });
  });

  it('hydrates input_ref payloads before invoking the component', async () => {
    workflow('hello', async (_ctx, input: { name: string }) => ({ message: `hello ${input.name}` }));

    const payloadBytes = new TextEncoder().encode(JSON.stringify({ name: 'Ada' }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      expect(url.toString()).toBe('https://payload.example/input.json?sig=1');
      expect(init?.method).toBe('GET');
      return new Response(payloadBytes, {
        status: 200,
        headers: { 'content-length': payloadBytes.byteLength.toString() },
      });
    };

    try {
      const handler = serve();
      const response = await handler.fetch(new Request('http://localhost:8787/agnt5/invoke', {
        method: 'POST',
        body: JSON.stringify({
          protocol_version: 'workerless.v1',
          run_id: 'run-ref-1',
          component_type: 'workflow',
          component_name: 'hello',
          input_ref: {
            kind: 'agnt5.object_store.signed_url.v1',
            url: 'https://payload.example/input.json?sig=1',
            method: 'GET',
            size_bytes: payloadBytes.byteLength,
            sha256: await sha256Hex(payloadBytes),
            content_type: 'application/json',
          },
        }),
      }));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: 'completed',
        output: { message: 'hello Ada' },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects expired input_ref payloads before fetching the signed URL', async () => {
    workflow('hello', async (_ctx, input: { name: string }) => ({ message: `hello ${input.name}` }));

    const payloadBytes = new TextEncoder().encode(JSON.stringify({ name: 'Ada' }));
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response(payloadBytes);
    };

    try {
      const handler = serve();
      const response = await handler.fetch(new Request('http://localhost:8787/agnt5/invoke', {
        method: 'POST',
        body: JSON.stringify({
          protocol_version: 'workerless.v1',
          run_id: 'run-ref-expired',
          component_type: 'workflow',
          component_name: 'hello',
          input_ref: {
            kind: 'agnt5.object_store.signed_url.v1',
            url: 'https://payload.example/input.json?sig=expired',
            method: 'GET',
            size_bytes: payloadBytes.byteLength,
            sha256: await sha256Hex(payloadBytes),
            expires_at_ms: Date.now() - 1,
          },
        }),
      }));
      const body = await response.json() as any;

      expect(response.status).toBe(410);
      expect(fetchCalled).toBe(false);
      expect(body).toMatchObject({
        status: 'failed',
        error: {
          code: 'WORKERLESS_INPUT_REF_EXPIRED',
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uploads large outputs through output_upload and returns output_ref', async () => {
    const output = { message: 'hello Ada', notes: 'x'.repeat(16) };
    workflow('large', async () => output);

    const outputBytes = new TextEncoder().encode(JSON.stringify(output));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      expect(url.toString()).toBe('https://payload.example/output.json?sig=1');
      expect(init?.method).toBe('PUT');
      expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
      expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe(JSON.stringify(output));
      return new Response(null, { status: 200 });
    };

    try {
      const handler = serve();
      const response = await handler.fetch(new Request('http://localhost:8787/agnt5/invoke', {
        method: 'POST',
        body: JSON.stringify({
          protocol_version: 'workerless.v1',
          run_id: 'run-output-ref-1',
          component_type: 'workflow',
          component_name: 'large',
          input: {},
          output_upload: {
            kind: 'agnt5.object_store.signed_url.v1',
            url: 'https://payload.example/output.json?sig=1',
            method: 'PUT',
            ref: 'workerless/payloads/project=p/deployment=d/run=r/attempt=0/output.json',
            threshold_bytes: 4,
            max_bytes: 1024,
            content_type: 'application/json',
          },
        }),
      }));
      const body = await response.json() as any;

      expect(response.status).toBe(200);
      expect(body).toEqual({
        status: 'completed',
        output_ref: {
          kind: 'agnt5.object_store.ref.v1',
          ref: 'workerless/payloads/project=p/deployment=d/run=r/attempt=0/output.json',
          size_bytes: outputBytes.byteLength,
          sha256: await sha256Hex(outputBytes),
          content_type: 'application/json',
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects expired output_upload before uploading the output_ref', async () => {
    workflow('large', async () => ({ message: 'hello Ada', notes: 'x'.repeat(16) }));

    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response(null, { status: 200 });
    };

    try {
      const handler = serve();
      const response = await handler.fetch(new Request('http://localhost:8787/agnt5/invoke', {
        method: 'POST',
        body: JSON.stringify({
          protocol_version: 'workerless.v1',
          run_id: 'run-output-ref-expired',
          component_type: 'workflow',
          component_name: 'large',
          input: {},
          output_upload: {
            kind: 'agnt5.object_store.signed_url.v1',
            url: 'https://payload.example/output.json?sig=expired',
            method: 'PUT',
            ref: 'workerless/payloads/project=p/deployment=d/run=r/attempt=0/output.json',
            threshold_bytes: 4,
            max_bytes: 1024,
            content_type: 'application/json',
            expires_at_ms: Date.now() - 1,
          },
        }),
      }));
      const body = await response.json() as any;

      expect(response.status).toBe(410);
      expect(fetchCalled).toBe(false);
      expect(body).toMatchObject({
        status: 'failed',
        error: {
          code: 'WORKERLESS_OUTPUT_REF_EXPIRED',
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns a stable failure when output_ref upload fails', async () => {
    workflow('large', async () => ({ notes: 'x'.repeat(16) }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 503 });

    try {
      const handler = serve();
      const response = await handler.fetch(new Request('http://localhost:8787/agnt5/invoke', {
        method: 'POST',
        body: JSON.stringify({
          protocol_version: 'workerless.v1',
          run_id: 'run-output-ref-1',
          component_type: 'workflow',
          component_name: 'large',
          input: {},
          output_upload: {
            kind: 'agnt5.object_store.signed_url.v1',
            url: 'https://payload.example/output.json?sig=1',
            method: 'PUT',
            ref: 'workerless/payloads/project=p/deployment=d/run=r/attempt=0/output.json',
            threshold_bytes: 4,
            max_bytes: 1024,
            content_type: 'application/json',
          },
        }),
      }));
      const body = await response.json() as any;

      expect(response.status).toBe(502);
      expect(body).toMatchObject({
        status: 'failed',
        error: {
          code: 'WORKERLESS_OUTPUT_REF_UPLOAD_FAILED',
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects input_ref payloads with a checksum mismatch', async () => {
    workflow('hello', async (_ctx, input: { name: string }) => ({ message: `hello ${input.name}` }));

    const payloadBytes = new TextEncoder().encode(JSON.stringify({ name: 'Ada' }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(payloadBytes, {
      status: 200,
      headers: { 'content-length': payloadBytes.byteLength.toString() },
    });

    try {
      const handler = serve();
      const response = await handler.fetch(new Request('http://localhost:8787/agnt5/invoke', {
        method: 'POST',
        body: JSON.stringify({
          protocol_version: 'workerless.v1',
          run_id: 'run-ref-1',
          component_type: 'workflow',
          component_name: 'hello',
          input_ref: {
            kind: 'agnt5.object_store.signed_url.v1',
            url: 'https://payload.example/input.json?sig=1',
            method: 'GET',
            size_bytes: payloadBytes.byteLength,
            sha256: '0'.repeat(64),
          },
        }),
      }));
      const body = await response.json() as any;

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        status: 'failed',
        error: {
          code: 'WORKERLESS_INPUT_REF_CHECKSUM_MISMATCH',
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects unsigned workerless invoke requests when signing is configured', async () => {
    workflow('hello', async (_ctx, input: { name: string }) => ({ message: `hello ${input.name}` }));

    const handler = serve({ signingSecret: 'test-signing-secret-123' });
    const response = await invoke(handler, 'workflow', 'hello', { name: 'Ada' });
    const body = await response.json() as any;

    expect(response.status).toBe(401);
    expect(body).toMatchObject({
      status: 'failed',
      error: {
        code: 'WORKERLESS_SIGNATURE_MISSING',
      },
    });
  });
});

async function invoke(
  handler: ReturnType<typeof serve>,
  componentType: string,
  componentName: string,
  input: unknown,
  checkpoint?: unknown,
  budget?: unknown,
  metadata?: Record<string, string>,
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
      metadata,
    }),
  }));
}

async function signedHeaders(secret: string, attemptID: string, body: string): Promise<Headers> {
  const timestamp = Date.now().toString();
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const message = encoder.encode(`${timestamp}.${attemptID}.${body}`);
  const digest = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, message));
  return new Headers({
    'X-AGNT5-Signature-Version': 'workerless-hmac-sha256.v1',
    'X-AGNT5-Timestamp': timestamp,
    'X-AGNT5-Attempt-ID': attemptID,
    'X-AGNT5-Signature': `sha256=${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
