import { event, webhook, workflow } from './workflow.js';
import { serve } from './workerless.js';
import type {
  WorkerlessManifest,
  WorkerlessServeOptions,
} from './workerless.js';
import type {
  WebhookTriggerOptions,
  WorkflowOptions,
} from './workflow.js';
import type { WorkflowHandler } from './types.js';

export interface WorkerlessCloudflareExecutionContext {
  waitUntil?(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export interface CloudflareWorkerlessHandler<Env = unknown> {
  fetch(
    request: Request,
    env?: Env,
    ctx?: WorkerlessCloudflareExecutionContext,
  ): Promise<Response>;
  manifest(): WorkerlessManifest;
}

export type WorkerlessCloudflareSigningSecretResolver<Env = unknown> =
  | string
  | ((
      env: Env | undefined,
      request: Request,
      ctx?: WorkerlessCloudflareExecutionContext,
    ) => string | undefined | Promise<string | undefined>);

export interface WorkerlessCloudflareServeOptions<Env = unknown>
  extends Omit<WorkerlessServeOptions<Env, WorkerlessCloudflareExecutionContext>, 'signingSecret'> {
  signingSecret?: WorkerlessCloudflareSigningSecretResolver<Env>;
}

export function serveCloudflare<Env = unknown>(
  options: WorkerlessCloudflareServeOptions<Env> = {},
): CloudflareWorkerlessHandler<Env> {
  const { signingSecret, ...serveOptions } = options;
  const genericOptions: WorkerlessServeOptions<Env, WorkerlessCloudflareExecutionContext> = {
    ...serveOptions,
  };

  if (signingSecret !== undefined) {
    genericOptions.signingSecret = (request, env, ctx) =>
      resolveCloudflareSigningSecret(signingSecret, env, request, ctx);
  }

  return serve<Env, WorkerlessCloudflareExecutionContext>(genericOptions);
}

async function resolveCloudflareSigningSecret<Env>(
  signingSecret: WorkerlessCloudflareSigningSecretResolver<Env>,
  env: Env | undefined,
  request: Request,
  ctx?: WorkerlessCloudflareExecutionContext,
): Promise<string | undefined> {
  const value = typeof signingSecret === 'function'
    ? await signingSecret(env, request, ctx)
    : signingSecret;
  const secret = value?.trim();
  return secret || undefined;
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
  WorkerlessBatchPolicy as CloudflareServerlessBatchPolicy,
  WorkerlessConcurrencyPolicy as CloudflareServerlessConcurrencyPolicy,
  WorkerlessDebouncePolicy as CloudflareServerlessDebouncePolicy,
  WorkerlessFlowControlPolicy as CloudflareServerlessFlowControlPolicy,
  WorkerlessIdempotencyPolicy as CloudflareServerlessIdempotencyPolicy,
  WorkerlessPriorityPolicy as CloudflareServerlessPriorityPolicy,
  WorkerlessRetryPolicy as CloudflareServerlessRetryPolicy,
  WorkerlessSingletonPolicy as CloudflareServerlessSingletonPolicy,
  WorkerlessWindowPolicy as CloudflareServerlessWindowPolicy,
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
