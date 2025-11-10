/**
 * AGNT5 Client SDK for invoking components
 */

export interface ClientOptions {
  /** Gateway URL (default: http://localhost:34181) */
  gatewayUrl?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

export interface RunOptions {
  /** Component type (default: "function") */
  componentType?: 'function' | 'workflow' | 'agent' | 'tool';
  /** Session ID for multi-turn conversations */
  sessionId?: string;
  /** User ID for user-scoped memory */
  userId?: string;
}

export interface RunResponse {
  runId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  output?: any;
  error?: string;
  submittedAt?: number;
  startedAt?: number;
  completedAt?: number;
}

/**
 * Error thrown when a component run fails
 */
export class RunError extends Error {
  public readonly runId?: string;

  constructor(message: string, runId?: string) {
    super(message);
    this.name = 'RunError';
    this.runId = runId;
    // Maintain proper stack trace for where error was thrown
    Error.captureStackTrace?.(this, RunError);
  }
}

/**
 * Proxy for calling methods on durable entities
 */
export class EntityProxy {
  constructor(
    private client: Client,
    private entityType: string,
    private key: string
  ) {}

  /**
   * Call an entity method
   */
  async call(method: string, args: any = {}): Promise<any> {
    const url = `${this.client['gatewayUrl']}/v1/entity/${this.entityType}/${this.key}/${method}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
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

    const data = (await response.json()) as RunResponse;

    if (data.status === 'failed') {
      throw new RunError(data.error || 'Unknown error', data.runId);
    }

    return data.output;
  }
}

/**
 * Client for invoking AGNT5 components
 *
 * @example
 * ```typescript
 * import { Client } from '@agnt5/sdk';
 *
 * const client = new Client({ gatewayUrl: 'http://localhost:34181' });
 *
 * // Synchronous execution
 * const result = await client.run('greet', { name: 'Alice' });
 * console.log(result); // { message: "Hello, Alice!" }
 *
 * // Async execution
 * const runId = await client.submit('long_task', { data: '...' });
 * const result = await client.waitForResult(runId);
 *
 * // Streaming
 * for await (const chunk of client.stream('generate_text', { prompt: '...' })) {
 *   process.stdout.write(chunk);
 * }
 *
 * // Entity method call
 * const count = await client.entity('Counter', 'user-123').call('increment', { amount: 5 });
 * ```
 */
export class Client {
  private readonly gatewayUrl: string;
  private readonly timeout: number;

  constructor(options: ClientOptions = {}) {
    this.gatewayUrl = (options.gatewayUrl || 'http://localhost:34181').replace(/\/$/, '');
    this.timeout = options.timeout || 30000;
  }

  /**
   * Execute a component synchronously and wait for the result
   */
  async run(component: string, inputData: any = {}, options: RunOptions = {}): Promise<any> {
    const componentType = options.componentType || 'function';
    const url = `${this.gatewayUrl}/v1/run/${componentType}/${component}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (options.sessionId) {
      headers['X-Session-ID'] = options.sessionId;
    }
    if (options.userId) {
      headers['X-User-ID'] = options.userId;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(inputData),
      signal: AbortSignal.timeout(this.timeout),
    });

    // Handle specific error cases
    if (response.status === 404) {
      const errorData = (await response.json().catch(() => ({}))) as any;
      throw new RunError(
        errorData.error || `Component '${component}' not found`,
        errorData.runId
      );
    }

    if (response.status === 503) {
      const errorData = (await response.json().catch(() => ({}))) as any;
      throw new RunError(
        `Service unavailable: ${errorData.error || 'Unknown error'}`,
        errorData.runId
      );
    }

    if (response.status === 504) {
      const errorData = (await response.json().catch(() => ({}))) as any;
      throw new RunError('Execution timeout', errorData.runId);
    }

    if (response.status === 500) {
      const errorData = (await response.json().catch(() => ({}))) as any;
      throw new RunError(
        errorData.error || 'Unknown error',
        errorData.runId
      );
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: Request failed`);
    }

    const data = (await response.json()) as RunResponse;

    // Check execution status
    if (data.status === 'failed') {
      throw new RunError(data.error || 'Unknown error', data.runId);
    }

    return data.output;
  }

  /**
   * Submit a component for async execution and return immediately
   */
  async submit(component: string, inputData: any = {}, options: Pick<RunOptions, 'componentType'> = {}): Promise<string> {
    const componentType = options.componentType || 'function';
    const url = `${this.gatewayUrl}/v1/submit/${componentType}/${component}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(inputData),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: Submission failed`);
    }

    const data = (await response.json()) as any;
    return data.runId || '';
  }

  /**
   * Get the current status of a run
   */
  async getStatus(runId: string): Promise<RunResponse> {
    const url = `${this.gatewayUrl}/v1/status/${runId}`;

    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: Failed to get status`);
    }

    return (await response.json()) as RunResponse;
  }

  /**
   * Get the result of a completed run
   */
  async getResult(runId: string): Promise<any> {
    const url = `${this.gatewayUrl}/v1/result/${runId}`;

    const response = await fetch(url, {
      method: 'GET',
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

    const data = (await response.json()) as RunResponse;

    if (data.status === 'failed') {
      throw new RunError(data.error || 'Unknown error', runId);
    }

    return data.output;
  }

  /**
   * Wait for a run to complete and return the result
   */
  async waitForResult(runId: string, timeoutMs: number = 300000, pollIntervalMs: number = 1000): Promise<any> {
    const startTime = Date.now();

    while (true) {
      // Check timeout
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        throw new RunError(`Timeout waiting for run to complete after ${timeoutMs}ms`, runId);
      }

      // Get current status
      const status = await this.getStatus(runId);

      // Check if complete
      if (status.status === 'completed' || status.status === 'failed' || status.status === 'cancelled') {
        return await this.getResult(runId);
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }

  /**
   * Stream responses from a component using Server-Sent Events (SSE)
   */
  async *stream(component: string, inputData: any = {}): AsyncGenerator<string, void, unknown> {
    const url = `${this.gatewayUrl}/v1/stream/${component}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
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

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        // Decode chunk and add to buffer
        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();

          // Skip empty lines and comments
          if (!trimmed || trimmed.startsWith(':')) {
            continue;
          }

          // Parse SSE format: "data: {...}"
          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.substring(6); // Remove "data: " prefix

            try {
              const data = JSON.parse(dataStr);

              // Check for completion
              if (data.done) {
                return;
              }

              // Check for error
              if (data.error) {
                throw new RunError(data.error, data.runId);
              }

              // Yield chunk
              if (data.chunk !== undefined) {
                yield data.chunk;
              }
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
}
