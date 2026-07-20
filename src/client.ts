/**
 * AGNT5 Client SDK for invoking components
 */

import {
  RunError,
  ConnectionError,
  TimeoutError,
  ValidationError,
  createErrorFromResponse,
} from './errors.js';
import { BatchResult, BatchStatusResult } from './batch.js';
import type { BatchConfig, BatchItemInput, CancelBatchResult } from './batch.js';
import { EvalResponse, BatchEvalResult, BatchEvalItemResult, LLMJudge, EvaluatorPreset, normalizeBatchEvalItems, normalizeScorerSpecs } from './eval.js';
import type { BatchEvalItem } from './eval.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClientOptions {
  /** Gateway URL (default: http://localhost:34181) */
  gatewayUrl?: string;
  /** API key for authentication (falls back to AGNT5_API_KEY env var) */
  apiKey?: string;
  /**
   * Default sub-tenant for all invocations, sent as `X-TENANT-ID`. Use this
   * to segment traffic for your own customers / end-users — it drives
   * per-tenant metrics, ingress fairness, and (future) scheduler isolation
   * on the gateway. Opaque string; must match `[A-Za-z0-9_-]{1,64}`. Falls
   * back to `AGNT5_TENANT_ID` env var. Per-call override available via
   * `tenant` on `run` / `submit` options.
   */
  tenantId?: string;
  /** Deployment ID for routing (falls back to AGNT5_DEPLOYMENT_ID env var) */
  deploymentId?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Max retry attempts for transient failures (default: 3) */
  maxRetries?: number;
  /** Initial retry delay in milliseconds (default: 1000) */
  retryDelayMs?: number;
}

export interface RunOptions {
  /** Component type (default: "function") */
  componentType?: 'function' | 'workflow' | 'agent' | 'tool';
  /** Explicit deployment ID for this call. Ambient AGNT5_DEPLOYMENT_ID is not used for component execution. */
  deploymentId?: string;
  /** Session ID for multi-turn conversations */
  sessionId?: string;
  /** User ID for user-scoped memory */
  userId?: string;
  /**
   * Sub-tenant override for this call (sent as `X-TENANT-ID`). Wins over
   * the client-level `tenantId` when set. Opaque customer string.
   */
  tenant?: string;
  /** Override max retries for this specific request */
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Run status & response types
// ---------------------------------------------------------------------------

/** Run execution status values */
export type RunStatus =
  | 'enqueued'
  | 'started'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused'
  | 'awaiting_input'
  | 'awaiting_user_input'
  | 'timeout'
  | 'unknown';

/** Structured error detail from a failed run */
export interface RunErrorDetail {
  code: string;
  message: string;
  details?: Record<string, any>;
}

/** Raw JSON shape returned by platform APIs */
interface RawRunResponse {
  run_id?: string;
  runId?: string;
  status_code?: number;
  status?: string;
  output?: any;
  output_data?: any;
  output_ref?: OutputRef;
  error?: any;
  error_message?: string;
  error_code?: string;
  duration_ms?: number;
  trace_id?: string;
  component?: string;
  created_at?: string;
  started_at?: string;
  completed_at?: string;
  failed_at?: string;
  session_id?: string;
  metadata?: Record<string, any>;
  result?: {
    output?: {
      output_data?: any;
      [key: string]: any;
    };
    [key: string]: any;
  };
}

export interface OutputRef {
  kind?: string;
  ref: string;
  size_bytes?: number;
  sha256?: string;
  content_type?: string;
}

/**
 * Typed response from run(), getResult(), waitForResult().
 *
 * Follows httpx-style patterns with isSuccess, isPending, isError, raiseForStatus().
 *
 * @example
 * ```typescript
 * const response = await client.run('greet', { name: 'Alice' });
 * if (response.isSuccess) {
 *   console.log(response.output);
 * } else {
 *   response.raiseForStatus();
 * }
 * ```
 */
export class RunResponse<T = any> {
  readonly runId: string;
  readonly statusCode: number;
  readonly status: RunStatus;
  readonly output: T | undefined;
  readonly outputRef: OutputRef | undefined;
  readonly error: RunErrorDetail | undefined;
  readonly durationMs: number | undefined;
  readonly traceId: string | undefined;
  readonly component: string | undefined;
  readonly createdAt: string | undefined;
  readonly startedAt: string | undefined;
  readonly completedAt: string | undefined;
  readonly failedAt: string | undefined;
  readonly sessionId: string | undefined;
  readonly metadata: Record<string, any> | undefined;

  constructor(raw: RawRunResponse) {
    this.runId = raw.run_id || raw.runId || '';
    this.statusCode = raw.status_code ?? (raw.status === 'completed' ? 200 : raw.status === 'failed' ? 500 : 202);
    this.status = (raw.status as RunStatus) || 'unknown';
    const nestedOutput = raw.result?.output;
    this.output = (
      raw.output ??
      raw.output_data ??
      nestedOutput?.output_data ??
      nestedOutput
    ) as T | undefined;
    this.outputRef = raw.output_ref;
    this.durationMs = raw.duration_ms;
    this.traceId = raw.trace_id;
    this.component = raw.component;
    this.createdAt = raw.created_at;
    this.startedAt = raw.started_at;
    this.completedAt = raw.completed_at;
    this.failedAt = raw.failed_at;
    this.sessionId = raw.session_id;
    this.metadata = raw.metadata;

    // Parse error — could be a string or a structured object
    if (raw.error || raw.error_message) {
      if (typeof raw.error === 'string') {
        this.error = { code: raw.error_code || 'EXECUTION_FAILED', message: raw.error };
      } else if (typeof raw.error === 'object') {
        this.error = {
          code: raw.error.code || raw.error_code || 'EXECUTION_FAILED',
          message: raw.error.message || String(raw.error),
          details: raw.error.details,
        };
      } else if (raw.error_message) {
        this.error = { code: raw.error_code || 'EXECUTION_FAILED', message: raw.error_message };
      }
    }
  }

  /** True if the run completed successfully */
  get isSuccess(): boolean {
    return this.status === 'completed' && !this.error;
  }

  /** True if the run is still in progress */
  get isPending(): boolean {
    return ['enqueued', 'started', 'running', 'paused', 'awaiting_input'].includes(this.status);
  }

  /** True if the run failed, was cancelled, or timed out */
  get isError(): boolean {
    return ['failed', 'cancelled', 'timeout'].includes(this.status) || this.statusCode === 500;
  }

  /** Execution duration as milliseconds (undefined if not available) */
  get elapsed(): number | undefined {
    return this.durationMs;
  }

  /** True when the final output is stored out of band and must be dereferenced. */
  get hasOutputRef(): boolean {
    return this.outputRef !== undefined;
  }

  /** Throw RunError if the run failed */
  raiseForStatus(): void {
    if (this.isError) {
      if (this.error) {
        throw new RunError(this.error.message, this.runId, this.status, this.error.code);
      }
      throw new RunError(`Run failed with status: ${this.status}`, this.runId, this.status);
    }
  }
}

/** Response from submit() */
export interface SubmitResponse {
  runId: string;
  status: RunStatus;
  traceId?: string;
  component?: string;
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// SSE event types (A4)
// ---------------------------------------------------------------------------

/** Event received from SSE stream */
export interface ReceivedEvent {
  /** Event type string (e.g., 'run.started', 'output.delta', 'agent.iteration.completed') */
  eventType: string;
  /** Event data payload */
  data: Record<string, any>;
  /** Content block index for streaming events */
  contentIndex: number;
  /** Sequence number for ordering */
  sequence: number;
  /** Run identifier from the gateway event envelope, when available */
  runId?: string;
}

function gatewayEventPayload(data: Record<string, any>): Record<string, any> {
  const nested = data.data;
  const isGatewayEnvelope =
    data.event_type !== undefined ||
    data.eventType !== undefined ||
    data.run_id !== undefined ||
    data.runId !== undefined;
  return isGatewayEnvelope && nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested
    : data;
}

function streamingChunk(data: Record<string, any>): string | undefined {
  const value = data.content ?? data.delta ?? data.output_data ?? data.chunk;
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function streamingRunError(data: Record<string, any>, envelope: Record<string, any>): RunError {
  const rawError = data.error ?? data.error_message ?? 'Component execution failed';
  const message = typeof rawError === 'object' && rawError !== null
    ? rawError.message ?? JSON.stringify(rawError)
    : String(rawError);
  return new RunError(message, envelope.run_id ?? envelope.runId, 'failed');
}

// ---------------------------------------------------------------------------
// Entity proxy
// ---------------------------------------------------------------------------

/**
 * Proxy for calling methods on durable entities
 */
export class EntityProxy {
  constructor(
    private client: Client,
    private entityType: string,
    private key: string
  ) {}

  async call(method: string, args: any = {}): Promise<any> {
    const url = `${this.client['gatewayUrl']}/v1/entity/${this.entityType}/${this.key}/${method}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: this.client['buildHeaders'](),
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(this.client['timeout']),
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as any;
      throw new RunError(
        errorData.error || `HTTP ${response.status}: Entity method call failed`,
        errorData.runId
      );
    }

    const data = (await response.json()) as RawRunResponse;

    if (data.status === 'failed') {
      const errMsg = typeof data.error === 'string' ? data.error : data.error?.message || 'Unknown error';
      throw new RunError(errMsg, data.run_id || data.runId);
    }

    return data.output;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Client for invoking AGNT5 components
 *
 * @example
 * ```typescript
 * import { Client } from '@agnt5/sdk';
 *
 * // Local development
 * const client = new Client({ gatewayUrl: 'http://localhost:34181' });
 *
 * // Production with API key
 * const client = new Client({
 *   gatewayUrl: 'https://api.agnt5.com',
 *   apiKey: 'agnt5_sk_...',
 * });
 *
 * // Synchronous execution with typed response
 * const response = await client.run('greet', { name: 'Alice' });
 * if (response.isSuccess) {
 *   console.log(response.output);
 * }
 *
 * // Async execution
 * const submit = await client.submit('long_task', { data: '...' });
 * const result = await client.waitForResult(submit.runId);
 *
 * // Stream typed events
 * for await (const event of client.events(runId)) {
 *   console.log(event.eventType, event.data);
 * }
 * ```
 */
export class Client {
  private readonly gatewayUrl: string;
  private readonly apiKey: string | undefined;
  private readonly tenantId: string | undefined;
  private readonly deploymentId: string | undefined;
  private readonly deploymentIdIsAmbient: boolean;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(options: ClientOptions = {}) {
    const env = typeof process !== 'undefined' ? process.env : undefined;
    this.gatewayUrl = (options.gatewayUrl || env?.AGNT5_GATEWAY_URL || 'http://localhost:34181').replace(/\/$/, '');
    this.apiKey = options.apiKey || env?.AGNT5_API_KEY;
    this.tenantId = options.tenantId || env?.AGNT5_TENANT_ID;
    this.deploymentId = options.deploymentId || env?.AGNT5_DEPLOYMENT_ID;
    this.deploymentIdIsAmbient = !options.deploymentId && !!env?.AGNT5_DEPLOYMENT_ID;
    this.timeout = options.timeout || 30000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs || 1000;
  }

  /**
   * Build request headers with authentication and routing. `tenantOverride`
   * wins over the client-level `tenantId` when set.
   */
  private buildHeaders(
    extra?: Record<string, string>,
    tenantOverride?: string,
    options: { deploymentId?: string; includeAmbientDeploymentId?: boolean } = {},
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['X-API-KEY'] = this.apiKey;
    }
    const effectiveTenant = tenantOverride ?? this.tenantId;
    if (effectiveTenant) {
      headers['X-Tenant-ID'] = effectiveTenant;
    }
    const deploymentId = options.deploymentId
      || (options.includeAmbientDeploymentId === false && this.deploymentIdIsAmbient
        ? undefined
        : this.deploymentId);
    if (deploymentId) {
      headers['X-Deployment-ID'] = deploymentId;
    }
    if (extra) {
      Object.assign(headers, extra);
    }
    return headers;
  }

  /**
   * Retry failed requests with exponential backoff
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    maxRetries?: number
  ): Promise<T> {
    const retries = maxRetries ?? this.maxRetries;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        // Don't retry on these errors
        if (
          error instanceof ValidationError ||
          error instanceof RunError ||
          error instanceof TimeoutError
        ) {
          throw error;
        }

        if (attempt === retries) break;

        const delay = this.retryDelayMs * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /**
   * Execute a component synchronously and wait for the result.
   *
   * Returns a typed RunResponse with metadata (traceId, durationMs, status).
   */
  async run<T = any>(component: string, inputData: any = {}, options: RunOptions = {}): Promise<RunResponse<T>> {
    return this.withRetry(async () => {
      const componentType = options.componentType || 'function';
      const url = `${this.gatewayUrl}/v1/${componentType}s/${component}/run`;

      const extra: Record<string, string> = {};
      if (options.sessionId) {
        extra['X-Session-ID'] = options.sessionId;
      }
      if (options.userId) {
        extra['X-User-ID'] = options.userId;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: this.buildHeaders(extra, options.tenant, {
          deploymentId: options.deploymentId,
          includeAmbientDeploymentId: false,
        }),
        body: JSON.stringify(inputData),
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as any;
        const message = errorData.error || `Component '${component}' execution failed`;
        throw createErrorFromResponse(response.status, message, errorData.runId || errorData.run_id, url);
      }

      const data = (await response.json()) as RawRunResponse;
      return new RunResponse<T>(data);
    }, options.maxRetries);
  }

  /**
   * Submit a component for async execution and return immediately.
   */
  async submit(component: string, inputData: any = {}, options: Pick<RunOptions, 'componentType' | 'tenant' | 'deploymentId'> = {}): Promise<SubmitResponse> {
    const componentType = options.componentType || 'function';
    const url = `${this.gatewayUrl}/v1/${componentType}s/${component}/submit`;

    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(undefined, options.tenant, {
        deploymentId: options.deploymentId,
        includeAmbientDeploymentId: false,
      }),
      body: JSON.stringify(inputData),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: Submission failed`);
    }

    const data = (await response.json()) as any;
    return {
      runId: data.run_id || data.runId || '',
      status: (data.status as RunStatus) || 'enqueued',
      traceId: data.trace_id,
      component: data.component,
      createdAt: data.created_at,
    };
  }

  /**
   * Get the current status of a run.
   */
  async getStatus(runId: string): Promise<RunResponse> {
    const url = `${this.gatewayUrl}/v1/status/${runId}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: Failed to get status`);
    }

    const data = (await response.json()) as RawRunResponse;
    return new RunResponse(data);
  }

  /**
   * Get the result of a completed run.
   */
  async getResult<T = any>(runId: string): Promise<RunResponse<T>> {
    const url = `${this.gatewayUrl}/v1/result/${runId}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (response.status === 404) {
      const errorData = (await response.json().catch(() => ({}))) as any;
      const errorMsg = errorData.error || 'Run not found or not complete';
      const currentStatus = errorData.status || 'unknown';
      throw new RunError(`${errorMsg} (status: ${currentStatus})`, runId);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: Failed to get result`);
    }

    const data = (await response.json()) as RawRunResponse;
    return new RunResponse<T>(data);
  }

  /**
   * Get the output payload for a completed run, dereferencing workerless
   * output_ref payloads when the runtime stored large output out of band.
   */
  async getOutput<T = any>(runId: string): Promise<T> {
    const url = `${this.gatewayUrl}/v1/runs/${encodeURIComponent(runId)}/output`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (response.status === 404) {
      throw new RunError('Run not found', runId);
    }

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as any;
      const message = errorData.message || errorData.error || `HTTP ${response.status}: Failed to get output`;
      throw createErrorFromResponse(response.status, message, runId, url);
    }

    const data = (await response.json()) as { output?: T };
    return data.output as T;
  }

  /**
   * Return the final output for a completed response, dereferencing output_ref
   * payloads when workerless stored large output out of band.
   */
  async resolveOutput<T = any>(result: RunResponse<T>): Promise<T | undefined> {
    result.raiseForStatus();
    if (!result.isSuccess) {
      return undefined;
    }
    if (result.hasOutputRef) {
      if (!result.runId) {
        throw new RunError('Run output reference cannot be dereferenced without a run ID', result.runId, result.status);
      }
      return await this.getOutput<T>(result.runId);
    }
    return result.output;
  }

  /**
   * Wait for a run to complete and return the result.
   */
  async waitForResult<T = any>(runId: string, timeoutMs: number = 300000, pollIntervalMs: number = 1000): Promise<RunResponse<T>> {
    const startTime = Date.now();

    while (true) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        throw new RunError(`Timeout waiting for run to complete after ${timeoutMs}ms`, runId);
      }

      const status = await this.getStatus(runId);

      if (['completed', 'failed', 'cancelled', 'timeout'].includes(status.status)) {
        return await this.getResult<T>(runId);
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }

  /**
   * Wait for a run to complete and return only its final output.
   *
   * Large workerless outputs are dereferenced through the run output endpoint.
   */
  async waitForOutput<T = any>(runId: string, timeoutMs: number = 300000, pollIntervalMs: number = 1000): Promise<T | undefined> {
    const result = await this.waitForResult<T>(runId, timeoutMs, pollIntervalMs);
    return await this.resolveOutput<T>(result);
  }

  /**
   * Stream text chunks from a component using SSE.
   * For typed events, use events() instead.
   */
  async *stream(component: string, inputData: any = {}, options: Pick<RunOptions, 'componentType' | 'tenant' | 'deploymentId'> = {}): AsyncGenerator<string, void, unknown> {
    for await (const event of this.events(component, inputData, options)) {
      if (event.eventType === 'run.failed') {
        throw streamingRunError(event.data, { run_id: event.runId });
      }
      if (event.eventType === 'output.delta') {
        const chunk = streamingChunk(event.data);
        if (chunk !== undefined) yield chunk;
      } else if (event.data.chunk !== undefined) {
        yield String(event.data.chunk);
      }
    }
  }

  /**
   * Stream typed events from a component using Server-Sent Events.
   *
   * @example
   * ```typescript
   * for await (const event of client.events('my-workflow', { data: '...' })) {
   *   switch (event.eventType) {
   *     case 'output.delta':
   *       process.stdout.write(event.data.content);
   *       break;
   *     case 'run.completed':
   *       console.log('Done:', event.data.output);
   *       break;
   *   }
   * }
   * ```
   */
  async *events(component: string, inputData: any = {}, options: Pick<RunOptions, 'componentType' | 'tenant' | 'deploymentId'> = {}): AsyncGenerator<ReceivedEvent, void, unknown> {
    const componentType = options.componentType || 'function';
    const url = `${this.gatewayUrl}/v1/${componentType}s/${component}/stream`;

    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(undefined, options.tenant, {
        deploymentId: options.deploymentId,
        includeAmbientDeploymentId: false,
      }),
      body: JSON.stringify(inputData),
      signal: AbortSignal.timeout(300000), // 5 minute timeout for streaming
    });

    if (!response.ok) {
      throw new RunError(`HTTP ${response.status}: Streaming request failed`);
    }

    if (!response.body) {
      throw new RunError('No response body for streaming');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEventType = 'message';
    let sequence = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();

          // Skip comments
          if (trimmed.startsWith(':')) continue;

          // Empty line = end of event block
          if (!trimmed) {
            currentEventType = 'message';
            continue;
          }

          // Parse "event: <type>"
          if (trimmed.startsWith('event: ') || trimmed.startsWith('event:')) {
            currentEventType = trimmed.substring(trimmed.indexOf(':') + 1).trim();
            continue;
          }

          // Parse "data: <json>"
          if (trimmed.startsWith('data: ') || trimmed.startsWith('data:')) {
            const dataStr = trimmed.substring(trimmed.indexOf(':') + 1).trim();

            try {
              const data = JSON.parse(dataStr);
              const payload = gatewayEventPayload(data);

              // Check for stream-end signal
              if (data.done) return;

              // Check for error
              if (currentEventType === 'error') {
                throw streamingRunError(payload, data);
              }

              sequence++;
              yield {
                eventType: currentEventType,
                data: payload,
                contentIndex: payload.index ?? payload.content_index ?? payload.contentIndex ?? 0,
                sequence: payload.sequence ?? sequence,
                runId: data.run_id ?? data.runId ?? payload.run_id ?? payload.runId,
              };
            } catch (e) {
              if (e instanceof RunError) throw e;
              // Skip malformed JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Get a proxy for calling methods on a durable entity
   */
  entity(entityType: string, key: string): EntityProxy {
    return new EntityProxy(this, entityType, key);
  }

  /**
   * Get all journal events for a completed run.
   *
   * @example
   * ```typescript
   * const events = await client.getEvents(runId);
   * for (const event of events.events) {
   *   console.log(event.eventType, event.data);
   * }
   * ```
   */
  async getEvents(runId: string): Promise<EventsResponse> {
    const url = `${this.gatewayUrl}/v1/runs/${runId}/events`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      throw createErrorFromResponse(response.status, await response.text(), runId);
    }

    const data = await response.json() as any;
    const rawItems: any[] = Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.events)
        ? data.events
        : Array.isArray(data)
          ? data
          : [];
    const events: EventRecord[] = rawItems.map((e: any) => ({
      eventType: e.event_type || e.eventType || '',
      data: e.data || e.output_data || {},
      timestamp: e.timestamp || e.created_at,
      sequence: e.sequence ?? 0,
      correlationId: e.correlation_id || e.correlationId,
    }));

    return { events, runId };
  }

  /**
   * Get a proxy for invoking a workflow with fluent API.
   *
   * @example
   * ```typescript
   * const result = await client.workflow('support_bot').chat('Help me', 'session-123');
   * ```
   */
  workflow(workflowName: string): WorkflowProxy {
    return new WorkflowProxy(this, workflowName);
  }

  /**
   * Get a proxy for a session entity.
   *
   * @example
   * ```typescript
   * const session = client.session('Conversation', 'user-alice');
   * const response = await session.chat('Hello!');
   * ```
   */
  session(sessionType: string, key: string): SessionProxy {
    return new SessionProxy(this, sessionType, key);
  }

  // ─── Batch operations ───────────────────────────────────────────────

  /**
   * Execute a component in batch with multiple inputs.
   *
   * @example
   * ```typescript
   * const result = await client.batch('greet', [
   *   { input: { name: 'Alice' } },
   *   { input: { name: 'Bob' } },
   * ], { maxConcurrency: 5 });
   *
   * if (result.isSuccess) {
   *   console.log(result.outputs);
   * }
   * ```
   */
  async batch(
    component: string,
    items: Array<Record<string, any> | BatchItemInput>,
    options: BatchConfig & { componentType?: string; metadata?: Record<string, string>; deploymentId?: string } = {},
  ): Promise<BatchResult> {
    const componentType = options.componentType || 'function';
    const url = `${this.gatewayUrl}/v1/${componentType}s/${component}/batch`;

    // Normalize items: plain objects become { input: obj }
    const normalizedItems = items.map((item, i) => {
      if ('input' in item) {
        return { ...item, index: (item as BatchItemInput).index ?? i };
      }
      return { input: item, index: i };
    });

    const body: Record<string, any> = {
      items: normalizedItems,
      config: {
        max_concurrency: options.maxConcurrency ?? 10,
        continue_on_failure: options.continueOnFailure ?? true,
        ...(options.batchTimeoutMs && { batch_timeout_ms: options.batchTimeoutMs }),
        ...(options.defaultItemTimeoutMs && { default_item_timeout_ms: options.defaultItemTimeoutMs }),
      },
    };

    if (options.metadata) {
      body.metadata = options.metadata;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(undefined, undefined, {
        deploymentId: options.deploymentId,
        includeAmbientDeploymentId: false,
      }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.batchTimeoutMs || 3600000),
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as any;
      throw createErrorFromResponse(
        response.status,
        errorData.error || `Batch execution failed for '${component}'`,
        undefined,
        url,
      );
    }

    const data = await response.json();
    return new BatchResult(data as Record<string, any>);
  }

  /**
   * Get the status of a batch execution.
   */
  async getBatchStatus(batchId: string, includeResults: boolean = true): Promise<BatchStatusResult> {
    const url = `${this.gatewayUrl}/v1/batches/${batchId}?include_results=${includeResults}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw new RunError(`HTTP ${response.status}: Failed to get batch status`, batchId);
    }

    const data = await response.json();
    return new BatchStatusResult(data as Record<string, any>);
  }

  /**
   * Cancel a running batch execution.
   */
  async cancelBatch(batchId: string, reason?: string): Promise<CancelBatchResult> {
    const query = reason ? `?reason=${encodeURIComponent(reason)}` : '';
    const url = `${this.gatewayUrl}/v1/batches/${batchId}${query}`;

    const response = await fetch(url, {
      method: 'DELETE',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw new RunError(`HTTP ${response.status}: Failed to cancel batch`, batchId);
    }

    const data = (await response.json()) as any;
    return {
      batchId: data.batch_id || data.batchId || batchId,
      status: data.status || 'cancelled',
      cancelledItems: data.cancelled_items ?? data.cancelledItems ?? 0,
      completedItems: data.completed_items ?? data.completedItems ?? 0,
    };
  }

  // ─── Evaluation operations ──────────────────────────────────────────

  /**
   * Evaluate a component with scorers.
   *
   * @example
   * ```typescript
   * const result = await client.eval('greet', { name: 'Alice' }, {
   *   expected: 'Hello, Alice!',
   *   scorers: ['exact_match', 'contains'],
   * });
   *
   * if (result.passed) {
   *   console.log('All scorers passed');
   * }
   * ```
   */
  async eval<T = any>(
    component: string,
    inputData?: Record<string, any>,
    options: {
      expected?: any;
      scorers?: Array<string | LLMJudge | EvaluatorPreset | Record<string, any>>;
      componentType?: string;
      deploymentId?: string;
      sessionId?: string;
      userId?: string;
      timeout?: number;
    } = {},
  ): Promise<EvalResponse<T>> {
    const componentType = options.componentType || 'function';
    // Gateway exposes a single global eval route at POST /v1/eval; the
    // component identity goes in the body, not the URL. See
    // runtime/crates/gateway/src/server.rs and handlers/eval.rs
    // (EvalRequest fields). Mirrors sdk-python/src/agnt5/client.py:709.
    const url = `${this.gatewayUrl}/v1/eval`;

    // Default to exact_match if expected is provided but no scorers
    let scorers = options.scorers;
    if (options.expected !== undefined && (!scorers || scorers.length === 0)) {
      scorers = ['exact_match'];
    }

    const body: Record<string, any> = {
      component,
      component_type: componentType,
    };
    if (inputData !== undefined) body.input = inputData;
    if (options.expected !== undefined) body.expected = options.expected;
    if (scorers && scorers.length > 0) body.scorers = normalizeScorerSpecs(scorers);

    const extra: Record<string, string> = {};
    if (options.sessionId) extra['X-Session-ID'] = options.sessionId;
    if (options.userId) extra['X-User-ID'] = options.userId;

    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(extra, undefined, {
        deploymentId: options.deploymentId,
        includeAmbientDeploymentId: false,
      }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeout || this.timeout),
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as any;
      throw createErrorFromResponse(
        response.status,
        errorData.error || `Evaluation failed for '${component}'`,
        errorData.run_id || errorData.runId,
        url,
      );
    }

    const data = await response.json();
    return new EvalResponse<T>(data as Record<string, any>);
  }

  /**
   * Evaluate a component in batch with multiple inputs and scorers.
   *
   * @example
   * ```typescript
   * const result = await client.batchEval('greet', [
   *   { input: { name: 'Alice' }, expected: 'Hello, Alice!' },
   *   { input: { name: 'Bob' }, expected: 'Hello, Bob!' },
   * ], {
   *   scorers: ['exact_match'],
   *   maxConcurrency: 5,
   * });
   *
   * console.log(`Pass rate: ${(result.passRate * 100).toFixed(1)}%`);
   * ```
   */
  async batchEval(
    component: string,
    items: Array<Record<string, any> | BatchEvalItem>,
    options: {
      scorers?: Array<string | LLMJudge | EvaluatorPreset | Record<string, any>>;
      expected?: any[];
      componentType?: string;
      deploymentId?: string;
      maxConcurrency?: number;
      timeout?: number;
    } = {},
  ): Promise<BatchEvalResult> {
    const normalized = normalizeBatchEvalItems(items, options.expected);
    const maxConcurrency = options.maxConcurrency ?? 10;
    const startTime = Date.now();

    // Run evaluations with concurrency limit
    const results: BatchEvalItemResult[] = [];
    let running = 0;
    let nextIdx = 0;

    const runOne = async (item: typeof normalized[0], idx: number): Promise<void> => {
      try {
        const evalResponse = await this.eval(component, item.input, {
          expected: item.expected,
          scorers: options.scorers,
          componentType: options.componentType,
          deploymentId: options.deploymentId,
          timeout: options.timeout,
        });
        results.push(BatchEvalItemResult.fromEvalResponse(evalResponse, idx, item.itemId));
      } catch (error) {
        results.push(BatchEvalItemResult.fromException(error as Error, idx, item.itemId));
      }
    };

    // Simple semaphore-based concurrency
    await new Promise<void>((resolve) => {
      const tryNext = () => {
        while (running < maxConcurrency && nextIdx < normalized.length) {
          const item = normalized[nextIdx];
          const idx = nextIdx;
          nextIdx++;
          running++;
          runOne(item, idx).then(() => {
            running--;
            if (results.length === normalized.length) {
              resolve();
            } else {
              tryNext();
            }
          });
        }
        if (normalized.length === 0) resolve();
      };
      tryNext();
    });

    const totalDurationMs = Date.now() - startTime;
    const hasErrors = results.some(r => r.isFailed);
    const allErrors = results.every(r => r.isFailed);
    const status = allErrors ? 'failed' : hasErrors ? 'partial_failure' : 'completed';

    return new BatchEvalResult({
      batchId: `batch_eval_${Date.now()}`,
      status,
      results,
      durationMs: totalDurationMs,
    });
  }
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface EventRecord {
  eventType: string;
  data: Record<string, any>;
  timestamp?: string;
  sequence: number;
  correlationId?: string;
}

export interface EventsResponse {
  events: EventRecord[];
  runId: string;
}

// ---------------------------------------------------------------------------
// WorkflowProxy
// ---------------------------------------------------------------------------

export class WorkflowProxy {
  constructor(
    private client: Client,
    private workflowName: string,
  ) {}

  /** Execute the workflow synchronously */
  async run<T = any>(
    input?: Record<string, any>,
    options?: { sessionId?: string; userId?: string; tenant?: string; deploymentId?: string },
  ): Promise<RunResponse<T>> {
    return this.client.run<T>(this.workflowName, input, {
      componentType: 'workflow',
      sessionId: options?.sessionId,
      userId: options?.userId,
      tenant: options?.tenant,
      deploymentId: options?.deploymentId,
    });
  }

  /** Send a message to a chat-enabled workflow */
  async chat<T = any>(
    message: string,
    sessionId?: string,
    options?: { userId?: string; extra?: Record<string, any>; tenant?: string; deploymentId?: string },
  ): Promise<RunResponse<T>> {
    const input = { message, ...(options?.extra || {}) };
    return this.client.run<T>(this.workflowName, input, {
      componentType: 'workflow',
      sessionId,
      userId: options?.userId,
      tenant: options?.tenant,
      deploymentId: options?.deploymentId,
    });
  }

  /** Submit the workflow for async execution */
  async submit(input?: Record<string, any>, options?: { tenant?: string; deploymentId?: string }): Promise<SubmitResponse> {
    return this.client.submit(this.workflowName, input, {
      componentType: 'workflow',
      tenant: options?.tenant,
      deploymentId: options?.deploymentId,
    });
  }

  /** Stream events from workflow execution */
  async *events(
    input?: Record<string, any>,
    options?: { tenant?: string; deploymentId?: string },
  ): AsyncGenerator<ReceivedEvent> {
    yield* this.client.events(this.workflowName, input, {
      componentType: 'workflow',
      tenant: options?.tenant,
      deploymentId: options?.deploymentId,
    });
  }
}

// ---------------------------------------------------------------------------
// SessionProxy
// ---------------------------------------------------------------------------

export class SessionProxy extends EntityProxy {
  /** Send a chat message to the session entity */
  async chat(message: string, extra?: Record<string, any>): Promise<any> {
    return this.call('chat', { message, ...(extra || {}) });
  }

  /** Get conversation history from the session entity */
  async getHistory(): Promise<any> {
    return this.call('get_history', {});
  }
}
