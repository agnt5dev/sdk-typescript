import { isSuspensionRequested, isWaitingForUserInput } from './errors.js';
import { AgentRegistry, Message } from './agent.js';
import type { Agent, Message as AgentMessage } from './agent.js';
import { FunctionRegistry } from './function-registry.js';
import { ToolRegistry } from './tool.js';
import type { FunctionHandler, ToolHandler, WorkflowHandler } from './types.js';
import type { FunctionOptions } from './types.js';
import type { WorkerlessFlowControlPolicy } from './flow-control.js';
import { WorkerlessContext } from './workerless-context.js';
import type { WorkerlessEmittedEvent } from './workerless-context.js';
import { WorkflowRegistry } from './workflow-registry.js';
import type { TriggerSpec, WorkflowConfig } from './workflow-registry.js';

export type {
  WorkerlessBackoffType,
  WorkerlessBatchPolicy,
  WorkerlessConcurrencyPolicy,
  WorkerlessDebouncePolicy,
  WorkerlessFlowControlPolicy,
  WorkerlessFlowControlPriority,
  WorkerlessFlowControlScope,
  WorkerlessIdempotencyPolicy,
  WorkerlessPriorityPolicy,
  WorkerlessRetryPolicy,
  WorkerlessSingletonPolicy,
  WorkerlessWindowPolicy,
} from './flow-control.js';

const PROTOCOL_VERSION = 'workerless.v1';
const DEFAULT_MANIFEST_PATH = '/.well-known/agnt5';
const INVOKE_PATH = '/agnt5/invoke';
const SIGNATURE_VERSION = 'workerless-hmac-sha256.v1';
const SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000;
const SIGNATURE_HEADER = 'X-AGNT5-Signature';
const SIGNATURE_VERSION_HEADER = 'X-AGNT5-Signature-Version';
const SIGNATURE_TIMESTAMP_HEADER = 'X-AGNT5-Timestamp';
const SIGNATURE_ATTEMPT_ID_HEADER = 'X-AGNT5-Attempt-ID';
const INPUT_REF_KIND = 'agnt5.object_store.signed_url.v1';
const OUTPUT_UPLOAD_KIND = 'agnt5.object_store.signed_url.v1';
const OUTPUT_REF_KIND = 'agnt5.object_store.ref.v1';
const MAX_INPUT_REF_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_REF_BYTES = 64 * 1024 * 1024;

type WorkerlessComponentType = 'function' | 'workflow' | 'tool' | 'agent';

export type WorkerlessSigningSecretResolver<Env = unknown, RuntimeContext = unknown> =
  | string
  | ((
      request: Request,
      env?: Env,
      ctx?: RuntimeContext,
    ) => string | undefined | Promise<string | undefined>);

export type WorkerlessEnabledResolver<Env = unknown, RuntimeContext = unknown> =
  | boolean
  | ((
      request: Request,
      env?: Env,
      ctx?: RuntimeContext,
    ) => boolean | undefined | Promise<boolean | undefined>);

export interface WorkerlessServeOptions<Env = unknown, RuntimeContext = unknown> {
  serviceName?: string;
  serviceVersion?: string;
  workflows?: WorkflowHandler[];
  functions?: FunctionHandler[];
  tools?: ToolHandler[];
  agents?: Agent[];
  enabled?: WorkerlessEnabledResolver<Env, RuntimeContext>;
  signingSecret?: WorkerlessSigningSecretResolver<Env, RuntimeContext>;
}

export interface WorkerlessManifestComponent {
  name: string;
  type: WorkerlessComponentType;
  component_type: WorkerlessComponentType;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  configuration?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  triggers?: WorkerlessTriggerSpec[];
  flow_control?: Record<string, unknown>;
  priority?: number;
  max_concurrency?: number;
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
  input_ref?: WorkerlessPayloadRef;
  output_upload?: WorkerlessOutputUpload;
  metadata?: Record<string, string>;
  checkpoint?: WorkerlessCheckpoint;
  budget?: WorkerlessBudget;
}

export interface WorkerlessPayloadRef {
  kind?: string;
  url?: string;
  method?: string;
  size_bytes?: number;
  sha256?: string;
  content_type?: string;
  expires_at_ms?: number;
}

export interface WorkerlessOutputUpload {
  kind?: string;
  url?: string;
  method?: string;
  ref?: string;
  threshold_bytes?: number;
  max_bytes?: number;
  content_type?: string;
  expires_at_ms?: number;
}

export interface WorkerlessOutputRef {
  kind: typeof OUTPUT_REF_KIND;
  ref: string;
  size_bytes: number;
  sha256: string;
  content_type: string;
}

export interface WorkerlessHandler<Env = unknown, RuntimeContext = unknown> {
  (request: Request, env?: Env, ctx?: RuntimeContext): Promise<Response>;
  fetch(request: Request, env?: Env, ctx?: RuntimeContext): Promise<Response>;
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
  agent_sessions?: Record<string, WorkerlessAgentSessionCheckpoint>;
}

export interface WorkerlessAgentSessionCheckpoint {
  messages: AgentMessage[];
  updated_at_ms?: number;
}

export type WorkerlessResponseEvent = WorkerlessEmittedEvent;

export interface WorkerlessBudget {
  deadline_ms?: number;
  request_timeout_ms?: number;
  yield_before_timeout_ms?: number;
}

type ComponentEntry = {
  name: string;
  type: WorkerlessComponentType;
  invoke: (ctx: WorkerlessContext, input: unknown) => Promise<unknown> | unknown;
  metadata?: Record<string, unknown>;
  triggers?: WorkerlessTriggerSpec[];
  flowControl?: WorkerlessFlowControlPolicy;
  priority?: number;
  maxConcurrency?: number;
};

export function serve<Env = unknown, RuntimeContext = unknown>(
  options: WorkerlessServeOptions<Env, RuntimeContext> = {},
): WorkerlessHandler<Env, RuntimeContext> {
  const components = collectWorkerlessComponents();
  const manifest = buildWorkerlessManifest(options, components);

  const handler = async (request: Request, env?: Env, ctx?: RuntimeContext): Promise<Response> => {
    const url = new URL(request.url);
    const isManifestRequest = request.method === 'GET' && url.pathname === DEFAULT_MANIFEST_PATH;
    const isInvokeRequest = request.method === 'POST' && url.pathname === INVOKE_PATH;
    if ((isManifestRequest || isInvokeRequest) && !(await resolveWorkerlessEnabled(options.enabled, request, env, ctx))) {
      return failedResponse('WORKERLESS_DISABLED', 'AGNT5 serverless endpoint is disabled', 503);
    }
    if (isManifestRequest) {
      return jsonResponse(manifest, 200);
    }
    if (isInvokeRequest) {
      return handleInvoke(request, components, options.signingSecret, env, ctx);
    }
    return jsonResponse({ error: 'not_found', message: 'AGNT5 workerless route not found' }, 404);
  };

  const workerlessHandler = handler as WorkerlessHandler<Env, RuntimeContext>;
  workerlessHandler.fetch = handler;
  workerlessHandler.manifest = () => manifest;
  void options.workflows;
  void options.functions;
  void options.tools;
  void options.agents;
  return workerlessHandler;
}

async function resolveWorkerlessEnabled<Env = unknown, RuntimeContext = unknown>(
  enabled: WorkerlessEnabledResolver<Env, RuntimeContext> | undefined,
  request: Request,
  env?: Env,
  ctx?: RuntimeContext,
): Promise<boolean> {
  if (typeof enabled === 'boolean') {
    return enabled;
  }
  if (typeof enabled === 'function') {
    const resolved = await enabled(request, env, ctx);
    if (typeof resolved === 'boolean') {
      return resolved;
    }
  }
  return workerlessEnabledFromEnv(env);
}

function workerlessEnabledFromEnv(env: unknown): boolean {
  return workerlessEnvFlagEnabled(envValue(env, 'AGNT5_SERVERLESS_ENABLED'));
}

function workerlessEnvFlagEnabled(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return !['0', 'false', 'no', 'off', 'disabled'].includes(normalized);
}

function envValue(env: unknown, name: string): unknown {
  if (env && typeof env === 'object' && name in env) {
    return (env as Record<string, unknown>)[name];
  }
  if (typeof process !== 'undefined') {
    return process.env?.[name];
  }
  return undefined;
}

function collectWorkerlessComponents(): ComponentEntry[] {
  const entries = new Map<string, ComponentEntry>();

  for (const [name, fnConfig] of FunctionRegistry.getAll()) {
    entries.set(componentKey('function', name), {
      name,
      type: 'function',
      invoke: (ctx, input) => fnConfig.handler(ctx, input),
      metadata: {},
      flowControl: functionFlowControl(fnConfig.options),
      priority: fnConfig.options.priority,
      maxConcurrency: fnConfig.options.maxConcurrency,
    });
  }

  for (const [name, cfg] of WorkflowRegistry.all()) {
    entries.set(componentKey('workflow', name), {
      name,
      type: 'workflow',
      invoke: (ctx, input) => cfg.handler(ctx, input),
      metadata: workflowMetadata(cfg),
      triggers: normalizeTriggers(cfg.triggers),
      flowControl: cfg.flowControl ?? cfg.flow_control,
      priority: cfg.priority,
      maxConcurrency: cfg.maxConcurrency,
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

  for (const [name, agent] of AgentRegistry.all()) {
    entries.set(componentKey('agent', name), {
      name,
      type: 'agent',
      invoke: (ctx, input) => invokeWorkerlessAgent(agent, ctx, input),
      metadata: {
        model: agent.modelName,
      },
    });
  }

  return Array.from(entries.values());
}

function buildWorkerlessManifest(
  options: { serviceName?: string; serviceVersion?: string },
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
      const flowControl = normalizeFlowControlPolicy(component.flowControl);
      if (flowControl) {
        manifestComponent.flow_control = flowControl;
      }
      if (component.priority !== undefined) {
        manifestComponent.priority = component.priority;
      }
      if (component.maxConcurrency !== undefined) {
        manifestComponent.max_concurrency = component.maxConcurrency;
      }
      return manifestComponent;
    }),
  };
}

function functionFlowControl(options: FunctionOptions): WorkerlessFlowControlPolicy | undefined {
  const explicit = options.flowControl ?? options.flow_control;
  if (explicit || !options.retries) {
    return explicit;
  }
  return {
    retries: {
      maxAttempts: options.retries.maxAttempts,
      initialIntervalMs: options.retries.initialIntervalMs,
      maxIntervalMs: options.retries.maxIntervalMs,
    },
  };
}

function normalizeFlowControlPolicy(
  policy: WorkerlessFlowControlPolicy | undefined,
): Record<string, unknown> | undefined {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return undefined;
  }
  const normalized = normalizeFlowControlObject(policy as Record<string, unknown>, true);
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

const TOP_LEVEL_FLOW_CONTROL_KEYS: Record<string, string> = {
  retries: 'retries',
  concurrency: 'concurrency',
  throttle: 'throttle',
  rateLimit: 'rate_limit',
  rate_limit: 'rate_limit',
  debounce: 'debounce',
  batch: 'batch',
  priority: 'priority',
  singleton: 'singleton',
  idempotency: 'idempotency',
};

const FLOW_CONTROL_FIELD_KEYS: Record<string, string> = {
  maxAttempts: 'max_attempts',
  initialIntervalMs: 'initial_interval_ms',
  maxIntervalMs: 'max_interval_ms',
  periodMs: 'period_ms',
  windowMs: 'window_ms',
  maxSize: 'max_size',
  ttlMs: 'ttl_ms',
  keyExpression: 'key_expression',
};

function normalizeFlowControlObject(
  object: Record<string, unknown>,
  topLevel: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined) {
      continue;
    }
    const normalizedKey = topLevel
      ? TOP_LEVEL_FLOW_CONTROL_KEYS[key]
      : (FLOW_CONTROL_FIELD_KEYS[key] ?? key);
    if (!normalizedKey) {
      continue;
    }
    out[normalizedKey] = normalizeFlowControlValue(value);
  }
  return out;
}

function normalizeFlowControlValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeFlowControlValue);
  }
  if (value && typeof value === 'object') {
    return normalizeFlowControlObject(value as Record<string, unknown>, false);
  }
  return value;
}

async function handleInvoke<Env, RuntimeContext>(
  request: Request,
  components: ComponentEntry[],
  signingSecret?: WorkerlessSigningSecretResolver<Env, RuntimeContext>,
  env?: Env,
  runtimeContext?: RuntimeContext,
): Promise<Response> {
  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch (err) {
    return failedResponse('WORKERLESS_INVALID_REQUEST', errorMessage(err, 'request body could not be read'), 400);
  }

  const signatureFailure = await verifyWorkerlessInvokeRequest(request, bodyText, signingSecret, env, runtimeContext);
  if (signatureFailure) {
    return signatureFailure;
  }

  let payload: WorkerlessInvokePayload;
  try {
    payload = JSON.parse(bodyText) as WorkerlessInvokePayload;
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

  const input = await resolveWorkerlessInput(payload);
  if (!input.ok) {
    return input.response;
  }

  const runID = payload.run_id || request.headers.get('X-AGNT5-Run-ID') || `workerless-${Date.now()}`;
  const ctx = new WorkerlessContext(
    `workerless-${runID}`,
    runID,
    payload.attempt ?? 0,
    componentName,
    {
      checkpoints: checkpointStorageFromPayload(payload.checkpoint),
      workerlessDeadlineMs: payload.budget?.deadline_ms,
      workerlessYieldBeforeMs: payload.budget?.yield_before_timeout_ms,
      metadata: payload.metadata,
    },
  );

  try {
    const output = await component.invoke(ctx, input.value);
    const checkpoint = checkpointPayloadFromStorage(ctx.checkpointSnapshot());
    const events = ctx.eventsSnapshot();
    ctx.close();
    const completion = await completedWorkerlessResponse(output, checkpoint, payload.output_upload);
    return completion.ok ? jsonResponse(withWorkerlessEvents(completion.body, events), 200) : completion.response;
  } catch (err) {
    if (isSuspensionRequested(err)) {
      const checkpoint = checkpointPayloadFromStorage(err.checkpointState);
      const events = ctx.eventsSnapshot();
      ctx.close();
      const suspended: Record<string, unknown> = {
        status: 'suspended',
        reason: err.reason,
        checkpoint,
      };
      if (err.readyAtMs !== undefined) {
        suspended.ready_at_ms = err.readyAtMs;
      }
      if (err.timerKey) {
        suspended.timer_key = err.timerKey;
      }
      if (err.signalName) {
        suspended.signal_name = err.signalName;
      }
      if (err.waitingStep) {
        suspended.waiting_step = err.waitingStep;
      }
      if (err.deadlineMs !== undefined) {
        suspended.budget = {
          deadline_ms: err.deadlineMs,
        };
      }
      return jsonResponse(withWorkerlessEvents(suspended, events), 200);
    }
    if (isWaitingForUserInput(err)) {
      const checkpoint = checkpointPayloadFromStorage(err.checkpointState);
      const events = ctx.eventsSnapshot();
      ctx.close();
      const suspended: Record<string, unknown> = {
        status: 'suspended',
        reason: 'user_input_required',
        checkpoint,
        pause_index: err.pauseIndex,
        step_name: err.stepName,
        question: err.question,
        input_type: err.inputType,
        options: err.options,
        allow_custom: err.allowCustom,
        skippable: err.skippable,
      };
      if (err.stepEvents && Object.keys(err.stepEvents).length > 0) {
        suspended.step_events = err.stepEvents;
      }
      return jsonResponse(withWorkerlessEvents(suspended, events), 200);
    }
    const events = ctx.eventsSnapshot();
    ctx.close();
    return jsonResponse(withWorkerlessEvents({
      status: 'failed',
      error: {
        code: 'WORKERLESS_HANDLER_ERROR',
        message: errorMessage(err, 'workerless handler failed'),
      },
    }, events), 200);
  }
}

async function invokeWorkerlessAgent(
  agent: Agent,
  ctx: WorkerlessContext,
  input: unknown,
): Promise<string> {
  const sessionID = agentSessionID(input, ctx.metadata, ctx.runId);
  const userMessage = agentUserMessage(input);
  const history = agentHistoryFromCheckpoint(ctx.checkpointSnapshot(), sessionID)
    ?? agentHistoryFromInput(input);
  const result = await agent.run(userMessage, ctx, history);
  const updatedMessages = [
    ...history,
    Message.user(userMessage),
    Message.assistant(result.output),
  ];
  ctx.setCheckpoint(agentSessionCheckpointKey(sessionID), {
    messages: updatedMessages,
    updated_at_ms: Date.now(),
  });
  await ctx.emit({
    event_type: 'session.created',
    data: {
      session_id: sessionID,
      agent_name: agent.name,
      turn_count: updatedMessages.length,
    },
    metadata: {
      session_id: sessionID,
      agent_name: agent.name,
      session_type: 'agent',
    },
  });
  return result.output;
}

function agentSessionID(
  input: unknown,
  metadata: Record<string, string> | undefined,
  runID: string,
): string {
  const inputObject = plainObject(input);
  const fromInput = stringValue(inputObject?.session_id);
  const fromMetadata = stringValue(metadata?.session_id);
  return fromInput || fromMetadata || runID;
}

function agentUserMessage(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  const inputObject = plainObject(input);
  if (inputObject) {
    for (const key of ['prompt', 'message', 'input']) {
      const value = stringValue(inputObject[key]);
      if (value) {
        return value;
      }
    }
  }
  return stringifyForAgentMessage(input);
}

function agentHistoryFromInput(input: unknown): AgentMessage[] {
  return normalizeAgentMessages(plainObject(input)?.history);
}

function agentHistoryFromCheckpoint(
  storage: Record<string, unknown>,
  sessionID: string,
): AgentMessage[] | undefined {
  const checkpoint = plainObject(storage[agentSessionCheckpointKey(sessionID)]);
  if (!checkpoint) {
    return undefined;
  }
  return normalizeAgentMessages(checkpoint.messages);
}

function agentSessionCheckpointKey(sessionID: string): string {
  return `agent_session:${sessionID}`;
}

function normalizeAgentMessages(value: unknown): AgentMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      const object = plainObject(entry);
      if (!object) {
        return undefined;
      }
      const role = stringValue(object.role) || 'user';
      const content = stringValue(object.content) || '';
      return { role, content } as AgentMessage;
    })
    .filter((entry): entry is AgentMessage => Boolean(entry));
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function stringifyForAgentMessage(input: unknown): string {
  if (input === undefined || input === null) {
    return '';
  }
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

export async function verifyWorkerlessInvokeRequest<Env = unknown, RuntimeContext = unknown>(
  request: Request,
  bodyText: string,
  signingSecret?: WorkerlessSigningSecretResolver<Env, RuntimeContext>,
  env?: Env,
  ctx?: RuntimeContext,
): Promise<Response | undefined> {
  const secret = await resolveWorkerlessSigningSecret(signingSecret, request, env, ctx);
  if (!secret) {
    return undefined;
  }

  const timestamp = request.headers.get(SIGNATURE_TIMESTAMP_HEADER)?.trim();
  const attemptID = request.headers.get(SIGNATURE_ATTEMPT_ID_HEADER)?.trim();
  const signature = request.headers.get(SIGNATURE_HEADER)?.trim();
  const version = request.headers.get(SIGNATURE_VERSION_HEADER)?.trim();
  if (!timestamp || !attemptID || !signature) {
    return failedResponse('WORKERLESS_SIGNATURE_MISSING', 'workerless invoke signature headers are required', 401);
  }
  if (version && version !== SIGNATURE_VERSION) {
    return failedResponse('WORKERLESS_SIGNATURE_VERSION_UNSUPPORTED', 'workerless invoke signature version is unsupported', 401);
  }

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs)) {
    return failedResponse('WORKERLESS_SIGNATURE_TIMESTAMP_INVALID', 'workerless invoke signature timestamp is invalid', 401);
  }
  if (Math.abs(Date.now() - timestampMs) > SIGNATURE_MAX_SKEW_MS) {
    return failedResponse('WORKERLESS_SIGNATURE_EXPIRED', 'workerless invoke signature timestamp is outside the allowed window', 401);
  }

  let expected: string;
  try {
    expected = await signWorkerlessInvokeBody(secret, timestamp, attemptID, bodyText);
  } catch (err) {
    return failedResponse('WORKERLESS_SIGNATURE_ERROR', errorMessage(err, 'workerless invoke signature could not be verified'), 500);
  }
  if (!timingSafeEqual(signature, expected)) {
    return failedResponse('WORKERLESS_SIGNATURE_INVALID', 'workerless invoke signature is invalid', 401);
  }
  return undefined;
}

type WorkerlessInputResolution =
  | { ok: true; value: unknown }
  | { ok: false; response: Response };

type WorkerlessCompletion =
  | { ok: true; body: { status: 'completed'; output?: unknown; output_ref?: WorkerlessOutputRef; checkpoint?: WorkerlessCheckpoint } }
  | { ok: false; response: Response };

type WorkerlessOutputUploadValidation =
  | { ok: true; url: string; ref: string; maxBytes: number; contentType: string }
  | { ok: false; response: Response };

class WorkerlessInputRefTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerlessInputRefTooLargeError';
  }
}

async function completedWorkerlessResponse(
  output: unknown,
  checkpoint: WorkerlessCheckpoint | undefined,
  upload: WorkerlessOutputUpload | undefined,
): Promise<WorkerlessCompletion> {
  const inlineBody = { status: 'completed' as const, output, checkpoint };
  if (!upload) {
    return { ok: true, body: inlineBody };
  }

  let outputBytes: Uint8Array;
  try {
    outputBytes = serializeWorkerlessOutput(output);
  } catch (err) {
    return {
      ok: false,
      response: failedResponse(
        'WORKERLESS_OUTPUT_SERIALIZATION_FAILED',
        errorMessage(err, 'workerless output could not be serialized'),
        500,
      ),
    };
  }

  const thresholdBytes = upload.threshold_bytes;
  if (
    typeof thresholdBytes !== 'number'
    || !Number.isSafeInteger(thresholdBytes)
    || thresholdBytes < 0
    || outputBytes.byteLength <= thresholdBytes
  ) {
    return { ok: true, body: inlineBody };
  }

  const validation = validateWorkerlessOutputUpload(upload);
  if (!validation.ok) {
    return validation;
  }

  if (outputBytes.byteLength > validation.maxBytes) {
    return {
      ok: false,
      response: failedResponse(
        'WORKERLESS_PAYLOAD_TOO_LARGE',
        `workerless output payload exceeds ${validation.maxBytes} bytes (got ${outputBytes.byteLength} bytes)`,
        413,
      ),
    };
  }

  let response: Response;
  try {
    response = await fetch(validation.url, {
      method: 'PUT',
      headers: {
        'content-type': validation.contentType,
      },
      body: outputBytes,
    });
  } catch (err) {
    return {
      ok: false,
      response: failedResponse(
        'WORKERLESS_OUTPUT_REF_UPLOAD_FAILED',
        errorMessage(err, 'workerless output_ref upload failed'),
        502,
      ),
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      response: failedResponse(
        'WORKERLESS_OUTPUT_REF_UPLOAD_FAILED',
        `workerless output_ref upload failed with HTTP ${response.status}`,
        502,
      ),
    };
  }

  let sha256: string;
  try {
    sha256 = await sha256Hex(outputBytes);
  } catch (err) {
    return {
      ok: false,
      response: failedResponse(
        'WORKERLESS_OUTPUT_REF_CHECKSUM_FAILED',
        errorMessage(err, 'workerless output_ref checksum could not be calculated'),
        500,
      ),
    };
  }

  const outputRef: WorkerlessOutputRef = {
    kind: OUTPUT_REF_KIND,
    ref: validation.ref,
    size_bytes: outputBytes.byteLength,
    sha256,
    content_type: validation.contentType,
  };
  return {
    ok: true,
    body: {
      status: 'completed',
      output_ref: outputRef,
      checkpoint,
    },
  };
}

function serializeWorkerlessOutput(output: unknown): Uint8Array {
  const serialized = JSON.stringify(output);
  return new TextEncoder().encode(serialized === undefined ? 'null' : serialized);
}

function withWorkerlessEvents<T extends object>(
  body: T,
  events: WorkerlessResponseEvent[],
): T & { events?: WorkerlessResponseEvent[] } {
  if (events.length === 0) {
    return body;
  }
  return {
    ...body,
    events,
  };
}

function validateWorkerlessOutputUpload(
  upload: WorkerlessOutputUpload,
): WorkerlessOutputUploadValidation {
  if (upload.kind && upload.kind !== OUTPUT_UPLOAD_KIND) {
    return outputUploadFailure('workerless output_upload kind is unsupported');
  }
  const method = (upload.method || 'PUT').trim().toUpperCase();
  if (method !== 'PUT') {
    return outputUploadFailure('workerless output_upload method is unsupported');
  }
  const url = parseHttpURL(upload.url);
  if (!url) {
    return outputUploadFailure('workerless output_upload url must be http or https');
  }
  const ref = upload.ref?.trim();
  if (!ref) {
    return outputUploadFailure('workerless output_upload ref is required');
  }
  const expiresAtMs = upload.expires_at_ms;
  if (expiresAtMs !== undefined) {
    if (typeof expiresAtMs !== 'number' || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) {
      return outputUploadFailure('workerless output_upload expires_at_ms is invalid');
    }
    if (expiresAtMs <= Date.now()) {
      return outputUploadFailure(
        'workerless output_upload has expired',
        'WORKERLESS_OUTPUT_REF_EXPIRED',
        410,
      );
    }
  }
  const maxBytes = upload.max_bytes ?? MAX_OUTPUT_REF_BYTES;
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    return outputUploadFailure('workerless output_upload max_bytes is invalid');
  }
  const contentType = upload.content_type?.trim() || 'application/json';
  if (contentType.split(';', 1)[0].toLowerCase() !== 'application/json') {
    return outputUploadFailure('workerless output_upload content_type is unsupported');
  }
  return { ok: true, url, ref, maxBytes, contentType };
}

function outputUploadFailure(
  message: string,
  code = 'WORKERLESS_OUTPUT_REF_INVALID',
  status = 400,
): WorkerlessOutputUploadValidation {
  return {
    ok: false,
    response: failedResponse(code, message, status),
  };
}

async function resolveWorkerlessInput(payload: WorkerlessInvokePayload): Promise<WorkerlessInputResolution> {
  if (!payload.input_ref) {
    return { ok: true, value: payload.input ?? {} };
  }
  if (payload.input !== undefined) {
    return inputResolutionFailure(
      'WORKERLESS_INPUT_REF_INVALID',
      'workerless invoke payload must not include both input and input_ref',
      400,
    );
  }

  const ref = payload.input_ref;
  if (ref.kind && ref.kind !== INPUT_REF_KIND) {
    return inputResolutionFailure('WORKERLESS_INPUT_REF_UNSUPPORTED', 'workerless input_ref kind is unsupported', 400);
  }
  const method = (ref.method || 'GET').trim().toUpperCase();
  if (method !== 'GET') {
    return inputResolutionFailure('WORKERLESS_INPUT_REF_UNSUPPORTED', 'workerless input_ref method is unsupported', 400);
  }
  const url = parseHttpURL(ref.url);
  if (!url) {
    return inputResolutionFailure('WORKERLESS_INPUT_REF_INVALID', 'workerless input_ref url must be http or https', 400);
  }
  const sizeBytes = ref.size_bytes;
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    return inputResolutionFailure('WORKERLESS_INPUT_REF_INVALID', 'workerless input_ref size_bytes is required', 400);
  }
  if (sizeBytes > MAX_INPUT_REF_BYTES) {
    return inputResolutionFailure(
      'WORKERLESS_INPUT_REF_TOO_LARGE',
      `workerless input_ref exceeds ${MAX_INPUT_REF_BYTES} bytes`,
      413,
    );
  }
  if (!ref.sha256 || !/^[a-f0-9]{64}$/i.test(ref.sha256)) {
    return inputResolutionFailure('WORKERLESS_INPUT_REF_INVALID', 'workerless input_ref sha256 is required', 400);
  }
  const expiresAtMs = ref.expires_at_ms;
  if (expiresAtMs !== undefined) {
    if (typeof expiresAtMs !== 'number' || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) {
      return inputResolutionFailure('WORKERLESS_INPUT_REF_INVALID', 'workerless input_ref expires_at_ms is invalid', 400);
    }
    if (expiresAtMs <= Date.now()) {
      return inputResolutionFailure('WORKERLESS_INPUT_REF_EXPIRED', 'workerless input_ref has expired', 410);
    }
  }

  let response: Response;
  try {
    response = await fetch(url, { method: 'GET' });
  } catch (err) {
    return inputResolutionFailure(
      'WORKERLESS_INPUT_REF_FETCH_FAILED',
      errorMessage(err, 'workerless input_ref could not be fetched'),
      502,
    );
  }
  if (!response.ok) {
    return inputResolutionFailure(
      'WORKERLESS_INPUT_REF_FETCH_FAILED',
      `workerless input_ref fetch failed with HTTP ${response.status}`,
      502,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await readResponseBytesLimited(response, Math.min(sizeBytes, MAX_INPUT_REF_BYTES));
  } catch (err) {
    const code = err instanceof WorkerlessInputRefTooLargeError
      ? 'WORKERLESS_INPUT_REF_TOO_LARGE'
      : 'WORKERLESS_INPUT_REF_FETCH_FAILED';
    return inputResolutionFailure(code, errorMessage(err, 'workerless input_ref could not be read'), code.endsWith('TOO_LARGE') ? 413 : 502);
  }
  if (bytes.byteLength !== sizeBytes) {
    return inputResolutionFailure('WORKERLESS_INPUT_REF_INVALID', 'workerless input_ref size_bytes did not match fetched payload', 400);
  }

  let actualSha256: string;
  try {
    actualSha256 = await sha256Hex(bytes);
  } catch (err) {
    return inputResolutionFailure(
      'WORKERLESS_INPUT_REF_CHECKSUM_FAILED',
      errorMessage(err, 'workerless input_ref checksum could not be calculated'),
      500,
    );
  }
  if (actualSha256.toLowerCase() !== ref.sha256.toLowerCase()) {
    return inputResolutionFailure('WORKERLESS_INPUT_REF_CHECKSUM_MISMATCH', 'workerless input_ref sha256 did not match fetched payload', 400);
  }

  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch (err) {
    return inputResolutionFailure('WORKERLESS_INPUT_REF_INVALID', errorMessage(err, 'workerless input_ref payload must be JSON'), 400);
  }
}

function inputResolutionFailure(code: string, message: string, status: number): WorkerlessInputResolution {
  return { ok: false, response: failedResponse(code, message, status) };
}

function parseHttpURL(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

async function readResponseBytesLimited(response: Response, limitBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > limitBytes) {
      throw new WorkerlessInputRefTooLargeError(`workerless input_ref exceeds ${limitBytes} bytes`);
    }
  }

  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value) {
          continue;
        }
        total += value.byteLength;
        if (total > limitBytes) {
          throw new WorkerlessInputRefTooLargeError(`workerless input_ref exceeds ${limitBytes} bytes`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return concatChunks(chunks, total);
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > limitBytes) {
    throw new WorkerlessInputRefTooLargeError(`workerless input_ref exceeds ${limitBytes} bytes`);
  }
  return new Uint8Array(buffer);
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) {
    return chunks[0];
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function resolveWorkerlessSigningSecret<Env, RuntimeContext>(
  signingSecret: WorkerlessSigningSecretResolver<Env, RuntimeContext> | undefined,
  request: Request,
  env?: Env,
  ctx?: RuntimeContext,
): Promise<string | undefined> {
  const value = typeof signingSecret === 'function'
    ? await signingSecret(request, env, ctx)
    : signingSecret;
  const secret = value?.trim();
  return secret || undefined;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto is required for workerless input_ref checksum verification');
  }
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return bytesToHex(digest);
}

async function signWorkerlessInvokeBody(
  secret: string,
  timestamp: string,
  attemptID: string,
  bodyText: string,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto is required for workerless signature verification');
  }
  const encoder = new TextEncoder();
  const key = await subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const message = encoder.encode(`${timestamp}.${attemptID}.${bodyText}`);
  const digest = new Uint8Array(await subtle.sign('HMAC', key, message));
  return `sha256=${bytesToHex(digest)}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

function checkpointStorageFromPayload(checkpoint: WorkerlessCheckpoint | undefined): Record<string, unknown> {
  const storage: Record<string, unknown> = {};
  for (const [stepName, value] of Object.entries(checkpoint?.steps || {})) {
    storage[`step:${stepName}`] = value;
  }
  for (const [sessionID, value] of Object.entries(checkpoint?.agent_sessions || {})) {
    storage[agentSessionCheckpointKey(sessionID)] = value;
  }
  return storage;
}

function checkpointPayloadFromStorage(storage: Record<string, unknown>): WorkerlessCheckpoint | undefined {
  const steps: Record<string, unknown> = {};
  const agentSessions: Record<string, WorkerlessAgentSessionCheckpoint> = {};
  for (const [key, value] of Object.entries(storage)) {
    if (key.startsWith('step:')) {
      steps[key.slice('step:'.length)] = value;
    } else if (key.startsWith('agent_session:')) {
      const sessionID = key.slice('agent_session:'.length);
      const checkpoint = plainObject(value);
      if (sessionID && checkpoint) {
        agentSessions[sessionID] = {
          messages: normalizeAgentMessages(checkpoint.messages),
          updated_at_ms: typeof checkpoint.updated_at_ms === 'number' ? checkpoint.updated_at_ms : undefined,
        };
      }
    }
  }
  const hasSteps = Object.keys(steps).length > 0;
  const hasAgentSessions = Object.keys(agentSessions).length > 0;
  if (!hasSteps && !hasAgentSessions) {
    return undefined;
  }
  return {
    ...(hasSteps ? { steps } : {}),
    ...(hasAgentSessions ? { agent_sessions: agentSessions } : {}),
  };
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
    case 'agent':
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
