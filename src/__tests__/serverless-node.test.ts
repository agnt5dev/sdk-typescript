import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it } from 'vitest';
import { FunctionRegistry } from '../function.js';
import { ToolRegistry } from '../tool.js';
import { serveNode, workflow } from '../serverless-node.js';
import { WorkflowRegistry } from '../workflow.js';

describe('@agnt5/sdk/serverless/node', () => {
  beforeEach(() => {
    FunctionRegistry.clear();
    WorkflowRegistry.clear();
    ToolRegistry.clear();
  });

  it('serves manifests through a Node HTTP handler', async () => {
    workflow('hello', async (_ctx, input: { name?: string }) => ({ message: `hello ${input.name ?? 'world'}` }));
    const handler = serveNode({ serviceName: 'serverless-node' });
    const response = mockResponse();

    await handler(mockRequest('GET', '/.well-known/agnt5'), response);
    const manifest = JSON.parse(response.text()) as any;

    expect(response.statusCode).toBe(200);
    expect(manifest).toMatchObject({
      protocol_version: 'workerless.v1',
      service_name: 'serverless-node',
      components: [
        {
          name: 'hello',
          type: 'workflow',
          component_type: 'workflow',
        },
      ],
    });
  });

  it('adapts Node request bodies and responses to the generic workerless handler', async () => {
    workflow('hello', async (_ctx, input: { name: string }) => ({ message: `hello ${input.name}` }));
    const handler = serveNode();
    const response = mockResponse();

    await handler(mockRequest('POST', '/agnt5/invoke', JSON.stringify({
      protocol_version: 'workerless.v1',
      run_id: 'serverless-node-test',
      component_type: 'workflow',
      component_name: 'hello',
      input: { name: 'Ada' },
    }), { 'content-type': 'application/json' }), response);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.text())).toEqual({
      status: 'completed',
      output: { message: 'hello Ada' },
    });
  });

  it('returns 503 from Node handlers when serverless is disabled', async () => {
    const handler = serveNode({ enabled: false });
    const response = mockResponse();

    await handler(mockRequest('GET', '/.well-known/agnt5'), response);

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.text())).toMatchObject({
      status: 'failed',
      error: { code: 'WORKERLESS_DISABLED' },
    });
  });
});

function mockRequest(
  method: string,
  url: string,
  body = '',
  headers: IncomingHttpHeaders = {},
): IncomingMessage {
  const stream = Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(stream, {
    method,
    url,
    headers: {
      host: 'workerless.local',
      ...headers,
    },
    socket: { encrypted: false },
  });
  return stream as unknown as IncomingMessage;
}

function mockResponse(): ServerResponse & { text(): string } {
  const chunks: Buffer[] = [];
  const headers = new Map<string, number | string | readonly string[]>();
  return {
    statusCode: 200,
    statusMessage: '',
    setHeader(name: string, value: number | string | readonly string[]) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    end(chunk?: string | Uint8Array) {
      if (chunk !== undefined) {
        chunks.push(Buffer.from(chunk));
      }
      return this;
    },
    text() {
      return Buffer.concat(chunks).toString('utf8');
    },
  } as unknown as ServerResponse & { text(): string };
}
