import { beforeEach, describe, expect, it } from 'vitest';
import { FunctionRegistry } from '../function.js';
import { ToolRegistry } from '../tool.js';
import { serve, workflow, event } from '../serverless.js';
import { WorkflowRegistry } from '../workflow.js';

describe('@agnt5/sdk/serverless', () => {
  beforeEach(() => {
    FunctionRegistry.clear();
    WorkflowRegistry.clear();
    ToolRegistry.clear();
  });

  it('exports the generic serve and workflow helpers from one subpath', async () => {
    workflow(
      'hello',
      async (_ctx, input: { name?: string }) => ({ message: `hello ${input.name ?? 'world'}` }),
      { triggers: [event('hello.requested')] },
    );

    const handler = serve({ serviceName: 'serverless-generic' });
    const response = await handler.fetch(new Request('https://example.com/.well-known/agnt5'));
    const manifest = await response.json() as any;

    expect(response.status).toBe(200);
    expect(manifest).toMatchObject({
      protocol_version: 'workerless.v1',
      service_name: 'serverless-generic',
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

  it('passes runtime env and context to the signing secret resolver', async () => {
    workflow('hello', async (_ctx, input: { name: string }) => ({ message: `hello ${input.name}` }));

    const handler = serve<
      { AGNT5_SERVERLESS_SIGNING_SECRET?: string },
      { waitUntil(promise: Promise<unknown>): void }
    >({
      serviceName: 'serverless-generic',
      signingSecret: (_request, env, ctx) => {
        ctx?.waitUntil(Promise.resolve());
        return env?.AGNT5_SERVERLESS_SIGNING_SECRET;
      },
    });
    const body = JSON.stringify({
      protocol_version: 'workerless.v1',
      run_id: 'serverless-generic-test',
      component_type: 'workflow',
      component_name: 'hello',
      input: { name: 'Ada' },
    });
    const response = await handler.fetch(
      new Request('https://example.com/agnt5/invoke', {
        method: 'POST',
        headers: await signedHeaders('test-signing-secret-123', 'serverless-generic-test:0', body),
        body,
      }),
      { AGNT5_SERVERLESS_SIGNING_SECRET: 'test-signing-secret-123' },
      { waitUntil: () => undefined },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'completed',
      output: { message: 'hello Ada' },
    });
  });
});

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
