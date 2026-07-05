import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

import { event, webhook, workflow } from './workflow.js';
import { serve } from './workerless.js';
import type {
  WorkerlessHandler,
  WorkerlessManifest,
  WorkerlessServeOptions,
} from './workerless.js';
import type {
  WebhookTriggerOptions,
  WorkflowOptions,
} from './workflow.js';
import type { WorkflowHandler } from './types.js';

type NodeBaseURLResolver = string | ((request: IncomingMessage) => string);

export interface WorkerlessNodeServeOptions<Env = unknown, RuntimeContext = unknown>
  extends WorkerlessServeOptions<Env, RuntimeContext> {
  baseUrl?: NodeBaseURLResolver;
}

export interface WorkerlessNodeHandler<Env = unknown, RuntimeContext = unknown> {
  (
    request: IncomingMessage,
    response: ServerResponse,
    env?: Env,
    ctx?: RuntimeContext,
  ): Promise<void>;
  fetch(request: Request, env?: Env, ctx?: RuntimeContext): Promise<Response>;
  manifest(): WorkerlessManifest;
}

export function serveNode<Env = unknown, RuntimeContext = unknown>(
  options: WorkerlessNodeServeOptions<Env, RuntimeContext> = {},
): WorkerlessNodeHandler<Env, RuntimeContext> {
  const { baseUrl, ...serveOptions } = options;
  const workerless = serve<Env, RuntimeContext>(serveOptions);

  const handler = async (
    request: IncomingMessage,
    response: ServerResponse,
    env?: Env,
    ctx?: RuntimeContext,
  ): Promise<void> => {
    const fetchRequest = await nodeRequestToWorkerlessRequest(request, baseUrl);
    const fetchResponse = await workerless.fetch(fetchRequest, env, ctx);
    await writeWorkerlessResponse(response, fetchResponse);
  };

  const nodeHandler = handler as WorkerlessNodeHandler<Env, RuntimeContext>;
  nodeHandler.fetch = (request, env, ctx) => workerless.fetch(request, env, ctx);
  nodeHandler.manifest = () => workerless.manifest();
  return nodeHandler;
}

export async function nodeRequestToWorkerlessRequest(
  request: IncomingMessage,
  baseUrl?: NodeBaseURLResolver,
): Promise<Request> {
  const method = (request.method || 'GET').toUpperCase();
  const url = new URL(request.url || '/', resolveNodeBaseURL(request, baseUrl));
  const init: RequestInit = {
    method,
    headers: nodeHeadersToFetchHeaders(request.headers),
  };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = await readNodeRequestBody(request);
  }
  return new Request(url, init);
}

export async function writeWorkerlessResponse(
  response: ServerResponse,
  fetchResponse: Response,
): Promise<void> {
  response.statusCode = fetchResponse.status;
  if (fetchResponse.statusText) {
    response.statusMessage = fetchResponse.statusText;
  }
  fetchResponse.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });
  const body = new Uint8Array(await fetchResponse.arrayBuffer());
  response.end(body);
}

function resolveNodeBaseURL(request: IncomingMessage, baseUrl?: NodeBaseURLResolver): string {
  if (typeof baseUrl === 'function') {
    return baseUrl(request);
  }
  if (baseUrl) {
    return baseUrl;
  }
  const forwardedProto = firstHeaderValue(request.headers['x-forwarded-proto']);
  const proto = forwardedProto || (encryptedRequest(request) ? 'https' : 'http');
  const host = firstHeaderValue(request.headers['x-forwarded-host'])
    || firstHeaderValue(request.headers.host)
    || 'localhost';
  return `${proto}://${host}`;
}

function encryptedRequest(request: IncomingMessage): boolean {
  return Boolean((request.socket as { encrypted?: boolean } | undefined)?.encrypted);
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(',')[0]?.trim() || undefined;
}

function nodeHeadersToFetchHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(key, item);
      }
    } else {
      result.set(key, value);
    }
  }
  return result;
}

async function readNodeRequestBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    chunks.push(bytes);
    total += bytes.byteLength;
  }
  if (chunks.length === 1) {
    return chunks[0];
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export {
  event,
  serve,
  webhook,
  workflow,
};

export type {
  WebhookTriggerOptions,
  WorkflowHandler,
  WorkflowOptions,
};
export type {
  WorkerlessBatchPolicy as NodeServerlessBatchPolicy,
  WorkerlessConcurrencyPolicy as NodeServerlessConcurrencyPolicy,
  WorkerlessDebouncePolicy as NodeServerlessDebouncePolicy,
  WorkerlessFlowControlPolicy as NodeServerlessFlowControlPolicy,
  WorkerlessIdempotencyPolicy as NodeServerlessIdempotencyPolicy,
  WorkerlessPriorityPolicy as NodeServerlessPriorityPolicy,
  WorkerlessRetryPolicy as NodeServerlessRetryPolicy,
  WorkerlessSingletonPolicy as NodeServerlessSingletonPolicy,
  WorkerlessWindowPolicy as NodeServerlessWindowPolicy,
} from './flow-control.js';
export type {
  WorkerlessBudget,
  WorkerlessCheckpoint,
  WorkerlessHandler,
  WorkerlessInvokePayload,
  WorkerlessManifest,
  WorkerlessManifestComponent,
  WorkerlessOutputRef,
  WorkerlessOutputUpload,
  WorkerlessPayloadRef,
  WorkerlessServeOptions,
  WorkerlessSigningSecretResolver,
} from './workerless.js';
