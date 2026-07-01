import { event, webhook, WorkflowRegistry } from './workflow-registry.js';
import { serve, verifyWorkerlessInvokeRequest } from './workerless.js';
import type { Context, WorkflowHandler } from './types.js';
import type { WebhookTriggerOptions, WorkflowOptions } from './workflow-registry.js';
import type {
  WorkerlessHandler,
  WorkerlessManifest,
  WorkerlessServeOptions,
} from './workerless.js';

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
  | ((env: Env | undefined, request: Request) => string | undefined | Promise<string | undefined>);

export interface WorkerlessCloudflareServeOptions<Env = unknown>
  extends Omit<WorkerlessServeOptions, 'signingSecret'> {
  signingSecret?: WorkerlessCloudflareSigningSecretResolver<Env>;
}

export function workflow<TInput = any, TOutput = any>(
  nameOrHandler: string | WorkflowHandler<TInput, TOutput>,
  handlerOrOptions?: WorkflowHandler<TInput, TOutput> | WorkflowOptions,
  optionsParam?: WorkflowOptions,
): WorkflowHandler<TInput, TOutput> {
  let workflowName: string;
  let handler: WorkflowHandler<TInput, TOutput>;
  let options: WorkflowOptions = {};

  if (typeof nameOrHandler === 'string') {
    workflowName = nameOrHandler;
    if (typeof handlerOrOptions === 'function') {
      handler = handlerOrOptions as WorkflowHandler<TInput, TOutput>;
      options = optionsParam || {};
    } else {
      throw new Error('Invalid workflow definition: handler must be a function');
    }
  } else if (typeof nameOrHandler === 'function') {
    handler = nameOrHandler as WorkflowHandler<TInput, TOutput>;
    workflowName = (handler as any).name || 'anonymous-workflow';
    options = (handlerOrOptions as WorkflowOptions) || {};
  } else {
    throw new Error('Invalid workflow definition');
  }

  if (options.name) {
    workflowName = options.name;
  }

  WorkflowRegistry.register({
    name: workflowName,
    handler,
    cron: options.cron,
    triggers: options.triggers,
  });

  const workflowWrapper = async (ctx: Context, input: TInput): Promise<TOutput> => {
    return handler(ctx, input);
  };
  (workflowWrapper as any)._agnt5_config = {
    name: workflowName,
    handler,
    cron: options.cron,
    triggers: options.triggers,
  };

  return workflowWrapper as WorkflowHandler<TInput, TOutput>;
}

export function serveCloudflare<Env = unknown>(
  options: WorkerlessCloudflareServeOptions<Env> = {},
): CloudflareWorkerlessHandler<Env> {
  const { signingSecret, ...serveOptions } = options;
  const handler: WorkerlessHandler = serve(serveOptions);
  return {
    async fetch(request: Request, env?: Env): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/agnt5/invoke') {
        const resolvedSecret = await resolveCloudflareSigningSecret(signingSecret, env, request);
        if (resolvedSecret) {
          const bodyText = await request.clone().text();
          const failure = await verifyWorkerlessInvokeRequest(request, bodyText, resolvedSecret);
          if (failure) {
            return failure;
          }
        }
      }
      return handler.fetch(request);
    },
    manifest(): WorkerlessManifest {
      return handler.manifest();
    },
  };
}

async function resolveCloudflareSigningSecret<Env>(
  signingSecret: WorkerlessCloudflareSigningSecretResolver<Env> | undefined,
  env: Env | undefined,
  request: Request,
): Promise<string | undefined> {
  const value = typeof signingSecret === 'function'
    ? await signingSecret(env, request)
    : signingSecret;
  const secret = value?.trim();
  return secret || undefined;
}

export {
  event,
  serve,
  webhook,
};

export type {
  WebhookTriggerOptions,
  WorkflowHandler,
  WorkflowOptions,
};
export type {
  WorkerlessBudget,
  WorkerlessCheckpoint,
  WorkerlessHandler,
  WorkerlessInvokePayload,
  WorkerlessManifest,
  WorkerlessManifestComponent,
  WorkerlessServeOptions,
  WorkerlessSigningSecretResolver,
} from './workerless.js';
