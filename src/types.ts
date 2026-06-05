import type { RuntimeContext } from './runtime-context.js';

/**
 * Retry policy configuration for functions
 */
export interface RetryPolicy {
  /** Maximum number of retry attempts */
  maxAttempts?: number;
  /** Initial delay before first retry in milliseconds */
  initialIntervalMs?: number;
  /** Maximum delay between retries in milliseconds */
  maxIntervalMs?: number;
}

/**
 * Backoff strategy for retries
 */
export interface BackoffPolicy {
  /** Type of backoff strategy */
  type: 'constant' | 'linear' | 'exponential';
  /** Multiplier for exponential/linear backoff */
  multiplier?: number;
}

/**
 * Configuration options for function definitions
 */
export interface FunctionOptions {
  /** Optional custom name for the function */
  name?: string;
  /** Retry policy configuration */
  retries?: RetryPolicy;
  /** Backoff strategy for retries */
  backoff?: BackoffPolicy;
  /** Timeout in milliseconds for function execution */
  timeout_ms?: number;
}

/**
 * Function handler type
 * @template TInput - Input parameter types
 * @template TOutput - Return type
 */
export type FunctionHandler<TInput = any, TOutput = any> = (
  ctx: Context,
  ...args: TInput[]
) => Promise<TOutput> | TOutput;

/**
 * Execution context provided to all AGNT5 components
 *
 * BREAKING CHANGE: State methods are now async to support durable storage
 */
export interface Context {
  // Metadata
  /** Unique invocation identifier */
  readonly invocationId: string;
  /** Workflow/run identifier */
  readonly runId: string;
  /** Current retry attempt number (0-indexed) */
  readonly attempt: number;
  /** Service name */
  readonly serviceName: string;
  /** Runtime-provided execution options for this invocation */
  readonly runtime: RuntimeContext;
  /**
   * Cancellation signal for this invocation. Aborted when the run is
   * cancelled (a CancelExecution arrives). Thread it into fetch/LLM SDK
   * calls (`fetch(url, { signal: ctx.signal })`) so in-flight work stops.
   */
  readonly signal: AbortSignal;

  // State management (async for durable storage)
  /** Get value from state (async) */
  get<T>(key: string, defaultValue?: T): Promise<T | undefined>;
  /** Set value in state (async) */
  set<T>(key: string, value: T): Promise<void>;
  /** Delete key from state (async) */
  delete(key: string): Promise<boolean>;

  // Checkpointing
  /** Execute and checkpoint a step */
  step<T>(stepName: string, fn: () => T | Promise<T>): Promise<T>;

  // Logging
  /** Structured logger */
  readonly logger: Logger;

  // Event emission
  /** Emit an event to the platform (no-op when running locally without a worker) */
  emit(event: any): Promise<void>;
}

/**
 * Structured logger interface
 */
export interface Logger {
  /** Log informational message */
  info(message: string, meta?: Record<string, any>): void;
  /** Log error message */
  error(message: string, meta?: Record<string, any>): void;
  /** Log warning message */
  warn(message: string, meta?: Record<string, any>): void;
  /** Log debug message */
  debug(message: string, meta?: Record<string, any>): void;
}

/**
 * Worker configuration options
 */
export interface WorkerOptions {
  /** Runtime mode */
  runtime?: 'standalone' | 'managed';
}

/**
 * JSON Schema type definitions
 */
export interface JSONSchema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: any[];
  const?: any;
  anyOf?: JSONSchema[];
  allOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  [key: string]: any;
}

/**
 * Tool handler function type
 */
export type ToolHandler<TInput = any, TOutput = any> = (
  ctx: Context,
  ...args: any[]
) => Promise<TOutput> | TOutput;

/**
 * Tool definition schema for agents
 */
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: JSONSchema;
  requires_confirmation?: boolean;
}

/**
 * Tool configuration options
 */
export interface ToolOptions {
  /** Custom tool name (defaults to function name) */
  name?: string;
  /** Tool description for agents */
  description?: string;
  /** Manually specified input schema */
  inputSchema?: JSONSchema;
  /** Automatically extract schema from function signature */
  autoSchema?: boolean;
  /** Require confirmation before execution */
  confirmation?: boolean;
}

/**
 * Entity method handler type
 */
export type EntityMethod<TInput = any, TOutput = any> = (
  ctx: Context,
  ...args: any[]
) => Promise<TOutput> | TOutput;

/**
 * Workflow handler type
 */
export type WorkflowHandler<TInput = any, TOutput = any> = (
  ctx: Context,
  input: TInput
) => Promise<TOutput> | TOutput;
