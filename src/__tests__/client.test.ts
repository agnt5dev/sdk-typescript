import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Client, RunResponse } from '../client';

// ---------------------------------------------------------------------------
// RunResponse unit tests
// ---------------------------------------------------------------------------

describe('RunResponse', () => {
  it('should parse a successful response', () => {
    const resp = new RunResponse({
      run_id: 'run-1',
      status: 'completed',
      output: { greeting: 'Hello' },
      duration_ms: 42,
      trace_id: 'trace-abc',
      status_code: 200,
    });

    expect(resp.runId).toBe('run-1');
    expect(resp.status).toBe('completed');
    expect(resp.output).toEqual({ greeting: 'Hello' });
    expect(resp.durationMs).toBe(42);
    expect(resp.traceId).toBe('trace-abc');
    expect(resp.isSuccess).toBe(true);
    expect(resp.isPending).toBe(false);
    expect(resp.isError).toBe(false);
    expect(resp.elapsed).toBe(42);
  });

  it('should parse a failed response with string error', () => {
    const resp = new RunResponse({
      run_id: 'run-2',
      status: 'failed',
      error: 'Something went wrong',
      status_code: 500,
    });

    expect(resp.isSuccess).toBe(false);
    expect(resp.isError).toBe(true);
    expect(resp.error?.message).toBe('Something went wrong');
    expect(resp.error?.code).toBe('EXECUTION_FAILED');
  });

  it('should parse a failed response with structured error', () => {
    const resp = new RunResponse({
      run_id: 'run-3',
      status: 'failed',
      error: { code: 'TIMEOUT', message: 'Function timed out after 30s' },
    });

    expect(resp.isError).toBe(true);
    expect(resp.error?.code).toBe('TIMEOUT');
    expect(resp.error?.message).toBe('Function timed out after 30s');
  });

  it('should parse output_data from the current backend response shape', () => {
    const resp = new RunResponse({
      run_id: 'run-4',
      status: 'completed',
      output_data: { greeting: 'Hello from output_data' },
      status_code: 200,
    });

    expect(resp.isSuccess).toBe(true);
    expect(resp.output).toEqual({ greeting: 'Hello from output_data' });
  });

  it('should parse output_ref from workerless large-output responses', () => {
    const resp = new RunResponse({
      run_id: 'run-ref',
      status: 'completed',
      output_ref: {
        kind: 'agnt5.object_store.ref.v1',
        ref: 'workerless/payloads/project=p/deployment=d/run=r/attempt=0/output.json',
        size_bytes: 12,
        sha256: 'a'.repeat(64),
        content_type: 'application/json',
      },
      status_code: 200,
    });

    expect(resp.isSuccess).toBe(true);
    expect(resp.output).toBeUndefined();
    expect(resp.hasOutputRef).toBe(true);
    expect(resp.outputRef?.ref).toBe('workerless/payloads/project=p/deployment=d/run=r/attempt=0/output.json');
  });

  it('should parse nested legacy result output_data responses', () => {
    const resp = new RunResponse({
      run_id: 'run-5',
      status: 'completed',
      result: {
        output: {
          output_data: 'Nested output',
        },
      },
      status_code: 200,
    });

    expect(resp.output).toBe('Nested output');
  });

  it('should parse error_message and error_code from the current backend response shape', () => {
    const resp = new RunResponse({
      run_id: 'run-6',
      status: 'failed',
      error_message: 'Invalid input: bad value',
      error_code: 'FUNCTION_ERROR',
      status_code: 500,
    });

    expect(resp.isError).toBe(true);
    expect(resp.error?.code).toBe('FUNCTION_ERROR');
    expect(resp.error?.message).toBe('Invalid input: bad value');
  });

  it('should detect pending status', () => {
    for (const status of ['enqueued', 'queued', 'started', 'running', 'paused', 'awaiting_input'] as const) {
      const resp = new RunResponse({ run_id: 'run-x', status, status_code: 202 });
      expect(resp.isPending).toBe(true);
      expect(resp.isSuccess).toBe(false);
    }
  });

  it('should infer statusCode from status when not provided', () => {
    const completed = new RunResponse({ run_id: 'r1', status: 'completed' });
    expect(completed.statusCode).toBe(200);

    const failed = new RunResponse({ run_id: 'r2', status: 'failed' });
    expect(failed.statusCode).toBe(500);

    const running = new RunResponse({ run_id: 'r3', status: 'running' });
    expect(running.statusCode).toBe(202);
  });

  it('raiseForStatus should throw on error', () => {
    const resp = new RunResponse({
      run_id: 'run-err',
      status: 'failed',
      error: 'boom',
    });

    expect(() => resp.raiseForStatus()).toThrow('boom');
  });

  it('raiseForStatus should not throw on success', () => {
    const resp = new RunResponse({
      run_id: 'run-ok',
      status: 'completed',
      output: 42,
    });

    expect(() => resp.raiseForStatus()).not.toThrow();
  });

  it('should handle runId in either field', () => {
    const resp1 = new RunResponse({ run_id: 'a' });
    expect(resp1.runId).toBe('a');

    const resp2 = new RunResponse({ runId: 'b' });
    expect(resp2.runId).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// Client construction tests
// ---------------------------------------------------------------------------

describe('Client', () => {
  it('should create with defaults', () => {
    const client = new Client();
    expect(client).toBeDefined();
    expect((client as any).timeout).toBe(45_000);
    expect((client as any).maxRetries).toBe(0);
  });

  it('should not retry synchronous runs by default', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: 'election in progress' }),
      {
        status: 503,
        headers: { 'content-type': 'application/json' },
      },
    ));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new Client({ gatewayUrl: 'http://gateway.test' });

      await expect(client.run('greet')).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('should retain explicit retry opt-in for idempotent synchronous runs', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'election in progress' }),
        {
          status: 503,
          headers: { 'content-type': 'application/json' },
        },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ run_id: 'run-1', status: 'completed', output: { ok: true } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new Client({
        gatewayUrl: 'http://gateway.test',
        maxRetries: 1,
        retryDelayMs: 1,
      });

      await expect(client.run('greet')).resolves.toMatchObject({
        runId: 'run-1',
        isSuccess: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('waits through status/result APIs when the gateway detaches an excess run waiter', async () => {
    const seen: string[] = [];
    let resultAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(new URL(url).pathname);
      if (url.endsWith('/run')) {
        return new Response(JSON.stringify({ run_id: 'run-detached', status: 'queued' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/status/run-detached')) {
        return new Response(JSON.stringify({ run_id: 'run-detached', status: 'completed' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/result/run-detached')) {
        resultAttempts += 1;
        if (resultAttempts === 1) {
          return new Response(JSON.stringify({ status: 'completed', error: 'result not projected yet' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          run_id: 'run-detached',
          status: 'completed',
          output: { ok: true },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new Client({ gatewayUrl: 'http://gateway.test', timeout: 1_000 });
      await expect(client.run('noop')).resolves.toMatchObject({
        runId: 'run-detached',
        isSuccess: true,
        output: { ok: true },
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(seen).toEqual([
      '/v1/functions/noop/run',
      '/v1/status/run-detached',
      '/v1/result/run-detached',
      '/v1/result/run-detached',
    ]);
  });

  it('sends invocation idempotency keys on run, submit, stream, and batch', async () => {
    const seen: Array<{ url: string; key: string | null }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, key: new Headers(init?.headers).get('Idempotency-Key') });
      if (url.endsWith('/stream')) {
        return new Response([
          'event: output.delta',
          'data: {"event_type":"output.delta","run_id":"run-1","data":{"content":"ok"}}',
          '',
          'event: run.completed',
          'data: {"event_type":"run.completed","run_id":"run-1","data":{"output_data":"ok"}}',
          '',
        ].join('\n'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (url.endsWith('/batch')) {
        return new Response(JSON.stringify({ batch_id: 'batch-1', status: 'queued', results: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/submit')) {
        return new Response(JSON.stringify({ run_id: 'run-1', status: 'enqueued' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ run_id: 'run-1', status: 'completed', output: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new Client({ gatewayUrl: 'http://gateway.test' });
      await client.run('checkout', { value: 1 }, { idempotencyKey: 'run-key' });
      await client.submit('checkout', { value: 1 }, { idempotencyKey: 'submit-key' });
      for await (const _chunk of client.stream(
        'checkout',
        { value: 1 },
        { idempotencyKey: 'stream-key' },
      )) {
        // Consume the stream so the request executes.
      }
      await client.batch(
        'checkout',
        [{ value: 1 }],
        { idempotencyKey: 'batch-key' },
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(seen.map(({ key }) => key)).toEqual([
      'run-key',
      'submit-key',
      'stream-key',
      'batch-key',
    ]);
  });

  it('should accept custom gateway URL', () => {
    const client = new Client({ gatewayUrl: 'https://api.example.com' });
    expect(client).toBeDefined();
  });

  it('should accept API key', () => {
    const client = new Client({ apiKey: 'agnt5_sk_test123' });
    expect(client).toBeDefined();
  });

  it('should strip trailing slash from gateway URL', () => {
    const client = new Client({ gatewayUrl: 'http://localhost:34181/' });
    // Access private field for testing
    expect((client as any).gatewayUrl).toBe('http://localhost:34181');
  });

  it('should include API key in headers', () => {
    const client = new Client({ apiKey: 'agnt5_sk_test' });
    const headers = (client as any).buildHeaders();
    expect(headers['X-API-KEY']).toBe('agnt5_sk_test');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('should not include API key header when no key provided', () => {
    const client = new Client();
    const headers = (client as any).buildHeaders();
    expect(headers['X-API-KEY']).toBeUndefined();
  });

  it('should merge extra headers', () => {
    const client = new Client({ apiKey: 'agnt5_sk_test' });
    const headers = (client as any).buildHeaders({
      'X-Session-ID': 'sess-1',
      'X-User-ID': 'user-1',
    });
    expect(headers['X-API-KEY']).toBe('agnt5_sk_test');
    expect(headers['X-Session-ID']).toBe('sess-1');
    expect(headers['X-User-ID']).toBe('user-1');
  });

  it('should include ambient deployment ID for default headers', () => {
    const origDeploymentId = process.env.AGNT5_DEPLOYMENT_ID;
    try {
      process.env.AGNT5_DEPLOYMENT_ID = 'dep-env';
      const client = new Client();
      const headers = (client as any).buildHeaders();

      expect(headers['X-Deployment-ID']).toBe('dep-env');
    } finally {
      if (origDeploymentId !== undefined) {
        process.env.AGNT5_DEPLOYMENT_ID = origDeploymentId;
      } else {
        delete process.env.AGNT5_DEPLOYMENT_ID;
      }
    }
  });

  it('should omit ambient deployment ID when component execution opts out', () => {
    const origDeploymentId = process.env.AGNT5_DEPLOYMENT_ID;
    try {
      process.env.AGNT5_DEPLOYMENT_ID = 'dep-env';
      const client = new Client();
      const headers = (client as any).buildHeaders(undefined, undefined, {
        includeAmbientDeploymentId: false,
      });

      expect(headers['X-Deployment-ID']).toBeUndefined();
    } finally {
      if (origDeploymentId !== undefined) {
        process.env.AGNT5_DEPLOYMENT_ID = origDeploymentId;
      } else {
        delete process.env.AGNT5_DEPLOYMENT_ID;
      }
    }
  });

  it('should keep explicit deployment ID when component execution opts out of ambient routing', () => {
    const origDeploymentId = process.env.AGNT5_DEPLOYMENT_ID;
    try {
      process.env.AGNT5_DEPLOYMENT_ID = 'dep-env';
      const client = new Client({ deploymentId: 'dep-explicit' });
      const headers = (client as any).buildHeaders(undefined, undefined, {
        includeAmbientDeploymentId: false,
      });

      expect(headers['X-Deployment-ID']).toBe('dep-explicit');
    } finally {
      if (origDeploymentId !== undefined) {
        process.env.AGNT5_DEPLOYMENT_ID = origDeploymentId;
      } else {
        delete process.env.AGNT5_DEPLOYMENT_ID;
      }
    }
  });

  it('should allow per-call deployment ID to override ambient execution routing', () => {
    const origDeploymentId = process.env.AGNT5_DEPLOYMENT_ID;
    try {
      process.env.AGNT5_DEPLOYMENT_ID = 'dep-env';
      const client = new Client();
      const headers = (client as any).buildHeaders(undefined, undefined, {
        deploymentId: 'dep-call',
        includeAmbientDeploymentId: false,
      });

      expect(headers['X-Deployment-ID']).toBe('dep-call');
    } finally {
      if (origDeploymentId !== undefined) {
        process.env.AGNT5_DEPLOYMENT_ID = origDeploymentId;
      } else {
        delete process.env.AGNT5_DEPLOYMENT_ID;
      }
    }
  });

  it('should read API key from environment', () => {
    const origEnv = process.env.AGNT5_API_KEY;
    try {
      process.env.AGNT5_API_KEY = 'agnt5_sk_from_env';
      const client = new Client();
      expect((client as any).apiKey).toBe('agnt5_sk_from_env');
    } finally {
      if (origEnv !== undefined) {
        process.env.AGNT5_API_KEY = origEnv;
      } else {
        delete process.env.AGNT5_API_KEY;
      }
    }
  });

  it('should prefer explicit API key over env', () => {
    const origEnv = process.env.AGNT5_API_KEY;
    try {
      process.env.AGNT5_API_KEY = 'agnt5_sk_from_env';
      const client = new Client({ apiKey: 'agnt5_sk_explicit' });
      expect((client as any).apiKey).toBe('agnt5_sk_explicit');
    } finally {
      if (origEnv !== undefined) {
        process.env.AGNT5_API_KEY = origEnv;
      } else {
        delete process.env.AGNT5_API_KEY;
      }
    }
  });

  it('getOutput should dereference output through the run output endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      run_id: 'run/with spaces',
      status: 'completed',
      output: { ok: true },
      source: 'object_store',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new Client({ gatewayUrl: 'http://gateway.test', apiKey: 'agnt5_sk_test' });

      const output = await client.getOutput('run/with spaces');

      expect(output).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledWith('http://gateway.test/v1/runs/run%2Fwith%20spaces/output', expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'X-API-KEY': 'agnt5_sk_test',
        }),
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resolveOutput should return inline output without an extra fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new Client({ gatewayUrl: 'http://gateway.test', apiKey: 'agnt5_sk_test' });
      const result = new RunResponse({
        run_id: 'run-inline',
        status: 'completed',
        output: { inline: true },
        status_code: 200,
      });

      await expect(client.resolveOutput(result)).resolves.toEqual({ inline: true });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resolveOutput should dereference workerless output_ref responses', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output: { large: true },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new Client({ gatewayUrl: 'http://gateway.test', apiKey: 'agnt5_sk_test' });
      const result = new RunResponse({
        run_id: 'run-ref',
        status: 'completed',
        output_ref: {
          kind: 'agnt5.object_store.ref.v1',
          ref: 'workerless/payloads/project=p/deployment=d/run=run-ref/attempt=0/output.json',
          size_bytes: 14,
          sha256: 'b'.repeat(64),
          content_type: 'application/json',
        },
        status_code: 200,
      });

      await expect(client.resolveOutput(result)).resolves.toEqual({ large: true });
      expect(fetchMock).toHaveBeenCalledWith('http://gateway.test/v1/runs/run-ref/output', expect.objectContaining({
        method: 'GET',
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('waitForOutput should wait for completion and dereference output_ref', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/status/run-ref')) {
        return new Response(JSON.stringify({
          run_id: 'run-ref',
          status: 'completed',
          status_code: 200,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/v1/result/run-ref')) {
        return new Response(JSON.stringify({
          run_id: 'run-ref',
          status: 'completed',
          output_ref: {
            kind: 'agnt5.object_store.ref.v1',
            ref: 'workerless/payloads/project=p/deployment=d/run=run-ref/attempt=0/output.json',
            size_bytes: 14,
            sha256: 'c'.repeat(64),
            content_type: 'application/json',
          },
          status_code: 200,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/v1/runs/run-ref/output')) {
        return new Response(JSON.stringify({
          output: { final: true },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: `unexpected URL: ${url}` }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new Client({ gatewayUrl: 'http://gateway.test', apiKey: 'agnt5_sk_test' });

      await expect(client.waitForOutput('run-ref', 1000, 1)).resolves.toEqual({ final: true });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('cancelBatch uses the shared DELETE route and forwards the reason', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      batch_id: 'batch-1',
      status: 'cancelled',
      cancelled_items: 2,
      completed_items: 1,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new Client({ gatewayUrl: 'http://gateway.test' });

      const result = await client.cancelBatch('batch-1', 'user requested');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://gateway.test/v1/batches/batch-1?reason=user%20requested',
        expect.objectContaining({ method: 'DELETE' }),
      );
      expect(result).toEqual({
        batchId: 'batch-1',
        status: 'cancelled',
        cancelledItems: 2,
        completedItems: 1,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stream unwraps gateway SSE envelopes and yields output deltas', async () => {
    const sse = [
      'event: output.delta',
      'data: {"event_type":"output.delta","run_id":"run-1","data":{"content":"hel","contentIndex":0}}',
      '',
      'event: output.delta',
      'data: {"event_type":"output.delta","run_id":"run-1","data":{"content":"lo","contentIndex":0}}',
      '',
      'event: run.completed',
      'data: {"event_type":"run.completed","run_id":"run-1","data":{"output_data":"hello"}}',
      '',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })));
    try {
      const client = new Client({ gatewayUrl: 'http://gateway.test' });
      const chunks: string[] = [];
      for await (const chunk of client.stream('generate')) chunks.push(chunk);

      const events = [];
      for await (const event of client.events('generate')) events.push(event);

      expect(chunks).toEqual(['hel', 'lo']);
      expect(events.filter(event => event.eventType === 'output.delta').map(event => event.data.content))
        .toEqual(['hel', 'lo']);
      expect(events.filter(event => event.eventType === 'output.delta').map(event => event.sequence))
        .toEqual([1, 2]);
      expect(events.filter(event => event.eventType === 'output.delta').map(event => event.runId))
        .toEqual(['run-1', 'run-1']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stream raises an error for an enveloped run.failed event', async () => {
    const sse = [
      'event: run.failed',
      'data: {"event_type":"run.failed","run_id":"run-2","data":{"error_message":"boom","error_code":"FUNCTION_ERROR"}}',
      '',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })));
    try {
      const client = new Client({ gatewayUrl: 'http://gateway.test' });
      const consume = async () => {
        for await (const _chunk of client.stream('generate')) {
          // Consume the stream to surface terminal failures.
        }
      };

      await expect(consume()).rejects.toThrow('boom');
    } finally {
      vi.unstubAllGlobals();
    }
  });

});
