import { ContextImpl } from './context.js';
import { isSuspensionRequested } from './errors.js';
import { FunctionRegistry } from './function.js';
import { ToolRegistry } from './tool.js';
import type { Context, FunctionHandler, ToolHandler, WorkflowHandler } from './types.js';
import { WorkflowRegistry } from './workflow.js';
import type { TriggerSpec, WorkflowConfig } from './workflow.js';

const PROTOCOL_VERSION = 'workerless.v1';
const DEFAULT_MANIFEST_PATH = '/.well-known/agnt5';
const INVOKE_PATH = '/agnt5/invoke';

export interface WorkerlessServeOptions {
  serviceName?: string;
  serviceVersion?: string;
  workflows?: WorkflowHandler[];
  functions?: FunctionHandler[];
  tools?: ToolHandler[];
}

export interface WorkerlessManifestComponent {
  name: string;
  type: 'function' | 'workflow' | 'tool';
  component_type: 'function' | 'workflow' | 'tool';
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  configuration?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  triggers?: WorkerlessTriggerSpec[];
}

export interface WorkerlessManifest {
  protocol_version: typeof PROTOCOL_VERSION;
  service_name?: string;
  service_version?: string;
  components: WorkerlessManifestComponent[];
}

export interface WorkerlessInvokePayload {
  protocol_version?: string;
  run_id?: string;
  project_id?: string;
  deployment_id?: string;
  component_type?: string;
  component_name?: string;
  attempt?: number;
  is_streaming?: boolean;
  input?: unknown;
  metadata?: Record<string, string>;
  checkpoint?: WorkerlessCheckpoint;
  budget?: WorkerlessBudget;
}

export interface WorkerlessHandler {
  (request: Request): Promise<Response>;
  fetch(request: Request): Promise<Response>;
  manifest(): WorkerlessManifest;
}

type WorkerlessTriggerSpec = {
  trigger_id?: string;
  trigger_type: string;
  event_name?: string;
  filter_expression?: string;
  input_mapping?: string;
  batch_window_ms?: number;
  delay_expression?: string;
};

export interface WorkerlessCheckpoint {
  steps?: Record<string, unknown>;
}

export interface WorkerlessBudget {
  deadline_ms?: number;
  request_timeout_ms?: number;
  yield_before_timeout_ms?: number;
}

type ComponentEntry = {
  name: string;
  type: 'function' | 'workflow' | 'tool';
  invoke: (ctx: Context, input: unknown) => Promise<unknown> | unknown;
  metadata?: Record<string, unknown>;
  triggers?: WorkerlessTriggerSpec[];
};

export function serve(options: WorkerlessServeOptions = {}): WorkerlessHandler {
  const components = collectWorkerlessComponents();
  const manifest = buildWorkerlessManifest(options, components);

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === DEFAULT_MANIFEST_PATH) {
      return jsonResponse(manifest, 200);
    }
    if (request.method === 'POST' && url.pathname === INVOKE_PATH) {
      return handleInvoke(request, components);
    }
    return jsonResponse({ error: 'not_found', message: 'AGNT5 workerless route not found' }, 404);
  };

  const workerlessHandler = handler as WorkerlessHandler;
  workerlessHandler.fetch = handler;
  workerlessHandler.manifest = () => manifest;
  void options.workflows;
  void options.functions;
  void options.tools;
  return workerlessHandler;
}

function collectWorkerlessComponents(): ComponentEntry[] {
  const entries = new Map<string, ComponentEntry>();

  for (const [name, fnConfig] of FunctionRegistry.getAll()) {
    entries.set(componentKey('function', name), {
      name,
      type: 'function',
      invoke: (ctx, input) => fnConfig.handler(ctx, input),
      metadata: {},
    });
  }

  for (const [name, cfg] of WorkflowRegistry.all()) {
    entries.set(componentKey('workflow', name), {
      name,
      type: 'workflow',
      invoke: (ctx, input) => cfg.handler(ctx, input),
      metadata: workflowMetadata(cfg),
      triggers: normalizeTriggers(cfg.triggers),
    });
  }

  for (const [name, tool] of ToolRegistry.all()) {
    entries.set(componentKey('tool', name), {
      name,
      type: 'tool',
      invoke: (ctx, input) => tool.invoke(ctx, objectInput(input)),
      metadata: {
        description: tool.description,
        requires_confirmation: tool.confirmation,
      },
    });
  }

  return Array.from(entries.values());
}

function buildWorkerlessManifest(
  options: WorkerlessServeOptions,
  components: ComponentEntry[],
): WorkerlessManifest {
  return {
    protocol_version: PROTOCOL_VERSION,
    service_name: options.serviceName,
    service_version: options.serviceVersion,
    components: components.map((component) => {
      const manifestComponent: WorkerlessManifestComponent = {
        name: component.name,
        type: component.type,
        component_type: component.type,
      };
      if (component.metadata && Object.keys(component.metadata).length > 0) {
        manifestComponent.metadata = component.metadata;
      }
      if (component.triggers) {
        manifestComponent.triggers = component.triggers;
      }
      return manifestComponent;
    }),
  };
}

async function handleInvoke(request: Request, components: ComponentEntry[]): Promise<Response> {
  let payload: WorkerlessInvokePayload;
  try {
    payload = await request.json() as WorkerlessInvokePayload;
  } catch (err) {
    return failedResponse('WORKERLESS_INVALID_REQUEST', errorMessage(err, 'request body must be JSON'), 400);
  }

  if (payload.protocol_version && payload.protocol_version !== PROTOCOL_VERSION) {
    return failedResponse(
      'WORKERLESS_PROTOCOL_MISMATCH',
      `unsupported protocol_version ${payload.protocol_version}`,
      400,
    );
  }

  const componentType = normalizeComponentType(payload.component_type);
  const componentName = payload.component_name?.trim();
  if (!componentType || !componentName) {
    return failedResponse('WORKERLESS_COMPONENT_REQUIRED', 'component_type and component_name are required', 400);
  }

  const component = components.find(
    (candidate) => candidate.type === componentType && candidate.name === componentName,
  );
  if (!component) {
    return failedResponse(
      'WORKERLESS_COMPONENT_NOT_FOUND',
      `${componentType} component ${componentName} was not found`,
      404,
    );
  }

  const runID = payload.run_id || request.headers.get('X-AGNT5-Run-ID') || `workerless-${Date.now()}`;
  const ctx = new ContextImpl(
    `workerless-${runID}`,
    runID,
    payload.attempt ?? 0,
    componentName,
    {
      storage: 'memory',
      checkpoints: checkpointStorageFromPayload(payload.checkpoint),
      workerlessDeadlineMs: payload.budget?.deadline_ms,
      workerlessYieldBeforeMs: payload.budget?.yield_before_timeout_ms,
    },
  );

  try {
    const output = await component.invoke(ctx, payload.input ?? {});
    const checkpoint = checkpointPayloadFromStorage(ctx.checkpointSnapshot());
    ctx.close();
    return jsonResponse({ status: 'completed', output, checkpoint }, 200);
  } catch (err) {
    if (isSuspensionRequested(err)) {
      const checkpoint = checkpointPayloadFromStorage(err.checkpointState);
      ctx.close();
      return jsonResponse({
        status: 'suspended',
        reason: err.reason,
        checkpoint,
        budget: {
          deadline_ms: err.deadlineMs,
        },
      }, 200);
    }
    ctx.close();
    return failedResponse('WORKERLESS_HANDLER_ERROR', errorMessage(err, 'workerless handler failed'), 200);
  }
}

function checkpointStorageFromPayload(checkpoint: WorkerlessCheckpoint | undefined): Record<string, unknown> {
  const storage: Record<string, unknown> = {};
  for (const [stepName, value] of Object.entries(checkpoint?.steps || {})) {
    storage[`step:${stepName}`] = value;
  }
  return storage;
}

function checkpointPayloadFromStorage(storage: Record<string, unknown>): WorkerlessCheckpoint | undefined {
  const steps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(storage)) {
    if (key.startsWith('step:')) {
      steps[key.slice('step:'.length)] = value;
    }
  }
  if (Object.keys(steps).length === 0) {
    return undefined;
  }
  return { steps };
}

function workflowMetadata(cfg: WorkflowConfig): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (cfg.cron) {
    metadata.cron = cfg.cron;
  }
  return metadata;
}

function normalizeTriggers(triggers: TriggerSpec[] | undefined): WorkerlessTriggerSpec[] | undefined {
  if (!triggers || triggers.length === 0) {
    return undefined;
  }
  return triggers.map((trigger) => ({
    trigger_id: trigger.triggerId,
    trigger_type: trigger.triggerType,
    event_name: trigger.eventName,
    filter_expression: trigger.filterExpression,
    input_mapping: trigger.inputMapping,
    batch_window_ms: trigger.batchWindowMs,
    delay_expression: trigger.delayExpression,
  }));
}

function normalizeComponentType(value: string | undefined): ComponentEntry['type'] | undefined {
  switch (value?.trim().toLowerCase()) {
    case 'function':
    case 'workflow':
    case 'tool':
      return value.trim().toLowerCase() as ComponentEntry['type'];
    default:
      return undefined;
  }
}

function objectInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function componentKey(componentType: string, name: string): string {
  return `${componentType}:${name}`;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function failedResponse(code: string, message: string, status: number): Response {
  return jsonResponse({
    status: 'failed',
    error: {
      code,
      message,
    },
  }, status);
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  if (typeof err === 'string' && err) {
    return err;
  }
  return fallback;
}
