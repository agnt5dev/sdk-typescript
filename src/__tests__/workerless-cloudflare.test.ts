import { beforeEach, describe, expect, it } from 'vitest';
import { FunctionRegistry } from '../function.js';
import { ToolRegistry } from '../tool.js';
import { WorkflowRegistry } from '../workflow.js';
import { serveCloudflare, workflow } from '../serverless-cloudflare.js';

describe('serveCloudflare()', () => {
  beforeEach(() => {
    FunctionRegistry.clear();
    WorkflowRegistry.clear();
    ToolRegistry.clear();
  });

  it('adapts workerless serve() to the Cloudflare fetch export shape', async () => {
    workflow('hello', async (_ctx, input: { name: string }) => ({ message: `hello ${input.name}` }));

    const handler = serveCloudflare<{ ENVIRONMENT: string }>({
      serviceName: 'cloudflare-workerless',
      serviceVersion: 'm3',
    });

    const manifestResponse = await handler.fetch(
      new Request('https://example.workers.dev/.well-known/agnt5'),
      { ENVIRONMENT: 'test' },
      { waitUntil: () => undefined },
    );
    const manifest = await manifestResponse.json() as any;

    expect(manifestResponse.status).toBe(200);
    expect(manifest).toMatchObject({
      protocol_version: 'workerless.v1',
      service_name: 'cloudflare-workerless',
      service_version: 'm3',
      components: [
        {
          name: 'hello',
          type: 'workflow',
          component_type: 'workflow',
        },
      ],
    });
    expect(handler.manifest()).toMatchObject({ service_name: 'cloudflare-workerless' });
  });

  it('preserves checkpoint replay and budget suspension through the Cloudflare compatibility shim', async () => {
    let fetchCount = 0;
    workflow('research', async (ctx, input: { title: string }) => {
      const page = await ctx.step('fetch', async () => {
        fetchCount += 1;
        return { title: input.title, fetch_count: fetchCount };
      });
      if (ctx.attempt === 0) {
        await ctx.yieldIfNeeded();
      }
      return {
        summary: `summary:${page.title}`,
        fetch_count: page.fetch_count,
      };
    });

    const handler = serveCloudflare({ serviceName: 'cloudflare-workerless' });
    const suspended = await invoke(handler, {
      attempt: 0,
      budget: {
        deadline_ms: Date.now() - 1,
        yield_before_timeout_ms: 0,
      },
    });

    expect(suspended).toMatchObject({
      status: 'suspended',
      reason: 'budget',
      checkpoint: {
        steps: {
          fetch: {
            title: 'AGNT5',
            fetch_count: 1,
          },
        },
      },
    });

    const completed = await invoke(handler, {
      attempt: 1,
      checkpoint: suspended.checkpoint,
      budget: {
        deadline_ms: Date.now() + 60_000,
        yield_before_timeout_ms: 0,
      },
    });

    expect(completed).toMatchObject({
      status: 'completed',
      output: {
        summary: 'summary:AGNT5',
        fetch_count: 1,
      },
    });
    expect(fetchCount).toBe(1);
  });

  it('verifies signed invokes from a Cloudflare env secret', async () => {
    workflow('hello', async (_ctx, input: { name: string }) => ({ message: `hello ${input.name}` }));

    const handler = serveCloudflare<{ AGNT5_SERVERLESS_SIGNING_SECRET?: string }>({
      serviceName: 'cloudflare-workerless',
      signingSecret: (env) => env?.AGNT5_SERVERLESS_SIGNING_SECRET,
    });
    const body = JSON.stringify({
      protocol_version: 'workerless.v1',
      run_id: 'cloudflare-workerless-test',
      project_id: 'project-1',
      deployment_id: 'deployment-1',
      component_type: 'workflow',
      component_name: 'hello',
      input: { name: 'Ada' },
    });
    const response = await handler.fetch(new Request('https://example.workers.dev/agnt5/invoke', {
      method: 'POST',
      headers: await signedHeaders('test-signing-secret-123', 'cloudflare-workerless-test:0', body),
      body,
    }), {
      AGNT5_SERVERLESS_SIGNING_SECRET: 'test-signing-secret-123',
    });
    const result = await response.json() as any;

    expect(response.status).toBe(200);
    expect(result).toEqual({
      status: 'completed',
      output: { message: 'hello Ada' },
    });
  });
});

async function invoke(
  handler: ReturnType<typeof serveCloudflare>,
  overrides: Record<string, unknown>,
): Promise<any> {
  const response = await handler.fetch(new Request('https://example.workers.dev/agnt5/invoke', {
    method: 'POST',
    body: JSON.stringify({
      protocol_version: 'workerless.v1',
      run_id: 'cloudflare-workerless-test',
      project_id: 'project-1',
      deployment_id: 'deployment-1',
      component_type: 'workflow',
      component_name: 'research',
      input: { title: 'AGNT5' },
      ...overrides,
    }),
  }));
  return response.json();
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
