/**
 * AGNT5 Error Classes
 *
 * Comprehensive error hierarchy for the AGNT5 SDK.
 * Mirrors the Python SDK error structure for consistency.
 */

/**
 * Base class for all AGNT5 errors
 */
export class AGNT5Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AGNT5Error';
    Error.captureStackTrace?.(this, this.constructor);
  }
}

/**
 * Configuration errors (invalid SDK configuration)
 */
export class ConfigurationError extends AGNT5Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Execution errors (runtime errors during component execution)
 */
export class ExecutionError extends AGNT5Error {
  public readonly componentName?: string;
  public readonly componentType?: string;

  constructor(message: string, componentName?: string, componentType?: string) {
    super(message);
    this.name = 'ExecutionError';
    this.componentName = componentName;
    this.componentType = componentType;
  }
}

/**
 * Retry errors (max retry attempts exceeded)
 */
export class RetryError extends AGNT5Error {
  public readonly attempts: number;
  public readonly lastError?: Error;

  constructor(message: string, attempts: number, lastError?: Error) {
    super(message);
    this.name = 'RetryError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/**
 * State operation errors (failed to get/set/delete state)
 */
export class StateError extends AGNT5Error {
  public readonly key?: string;
  public readonly operation?: 'get' | 'set' | 'delete' | 'clear';

  constructor(message: string, operation?: 'get' | 'set' | 'delete' | 'clear', key?: string) {
    super(message);
    this.name = 'StateError';
    this.operation = operation;
    this.key = key;
  }
}

/**
 * Checkpoint errors (failed to create or restore checkpoint)
 */
export class CheckpointError extends AGNT5Error {
  public readonly stepName?: string;
  public readonly sequenceNumber?: number;

  constructor(message: string, stepName?: string, sequenceNumber?: number) {
    super(message);
    this.name = 'CheckpointError';
    this.stepName = stepName;
    this.sequenceNumber = sequenceNumber;
  }
}

/**
 * Run errors (component invocation failed)
 */
export class RunError extends AGNT5Error {
  public readonly runId?: string;
  public readonly traceId?: string;
  public readonly status?: string;

  constructor(message: string, runId?: string, status?: string, traceId?: string) {
    super(message);
    this.name = 'RunError';
    this.runId = runId;
    this.status = status;
    this.traceId = traceId;
  }
}

/**
 * Human-in-the-loop exception (waiting for user input)
 * This is a special error that signals the workflow is paused
 */
export class WaitingForUserInputError extends AGNT5Error {
  public readonly runId: string;
  public readonly prompt: string;
  public readonly inputType?: string;
  public readonly choices?: string[];

  constructor(runId: string, prompt: string, inputType?: string, choices?: string[]) {
    super(`Waiting for user input: ${prompt}`);
    this.name = 'WaitingForUserInputError';
    this.runId = runId;
    this.prompt = prompt;
    this.inputType = inputType;
    this.choices = choices;
  }
}

/**
 * Connection errors (failed to connect to platform)
 */
export class ConnectionError extends AGNT5Error {
  public readonly endpoint?: string;
  public readonly statusCode?: number;

  constructor(message: string, endpoint?: string, statusCode?: number) {
    super(message);
    this.name = 'ConnectionError';
    this.endpoint = endpoint;
    this.statusCode = statusCode;
  }
}

/**
 * Timeout errors (operation exceeded time limit)
 */
export class TimeoutError extends AGNT5Error {
  public readonly timeoutMs: number;
  public readonly operation?: string;

  constructor(message: string, timeoutMs: number, operation?: string) {
    super(message);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
    this.operation = operation;
  }
}

/**
 * Validation errors (invalid input/output data)
 */
export class ValidationError extends AGNT5Error {
  public readonly field?: string;
  public readonly value?: any;
  public readonly expected?: string;

  constructor(message: string, field?: string, value?: any, expected?: string) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.value = value;
    this.expected = expected;
  }
}

/**
 * Authorization errors (insufficient permissions)
 */
export class AuthorizationError extends AGNT5Error {
  public readonly resource?: string;
  public readonly action?: string;

  constructor(message: string, resource?: string, action?: string) {
    super(message);
    this.name = 'AuthorizationError';
    this.resource = resource;
    this.action = action;
  }
}

/**
 * Type guard to check if an error is an AGNT5Error
 */
export function isAGNT5Error(error: unknown): error is AGNT5Error {
  return error instanceof AGNT5Error;
}

/**
 * Type guard to check if an error is a WaitingForUserInputError
 */
export function isWaitingForUserInput(error: unknown): error is WaitingForUserInputError {
  return error instanceof WaitingForUserInputError;
}

/**
 * Helper to extract error message from unknown error
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown error';
}

/**
 * Helper to create error from HTTP response
 */
export function createErrorFromResponse(
  status: number,
  message: string,
  runId?: string,
  endpoint?: string
): AGNT5Error {
  switch (status) {
    case 400:
      return new ValidationError(message);
    case 401:
    case 403:
      return new AuthorizationError(message);
    case 404:
      return new RunError(message, runId, 'not_found');
    case 408:
    case 504:
      return new TimeoutError(message, 30000);
    case 429:
      return new RetryError(message, 0);
    case 500:
    case 502:
    case 503:
      return new ConnectionError(message, endpoint, status);
    default:
      return new ExecutionError(message);
  }
}
