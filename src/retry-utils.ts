/**
 * Retry and backoff utilities for durable execution.
 *
 * This module provides utilities for parsing retry policies, calculating backoff delays,
 * and executing functions with retry logic.
 */

import type { RetryPolicy, BackoffPolicy, Context } from './types.js';
import { RetryError } from './errors.js';

/**
 * Default retry policy configuration
 */
export const DEFAULT_RETRY_POLICY: Required<RetryPolicy> = {
  maxAttempts: 3,
  initialIntervalMs: 1000, // 1 second
  maxIntervalMs: 60000,    // 60 seconds
};

/**
 * Default backoff policy configuration
 */
export const DEFAULT_BACKOFF_POLICY: Required<BackoffPolicy> = {
  type: 'exponential',
  multiplier: 2.0,
};

/**
 * Parse retry configuration from various forms.
 *
 * @param retries - Can be:
 *   - number: max_attempts (e.g., 5)
 *   - RetryPolicy: complete configuration
 *   - undefined: use default
 * @returns Complete RetryPolicy
 *
 * @example
 * ```typescript
 * parseRetryPolicy(5) // { maxAttempts: 5, initialIntervalMs: 1000, maxIntervalMs: 60000 }
 * parseRetryPolicy({ maxAttempts: 3, initialIntervalMs: 2000 })
 * parseRetryPolicy(undefined) // Uses defaults
 * ```
 */
export function parseRetryPolicy(retries?: number | RetryPolicy): Required<RetryPolicy> {
  if (retries === undefined || retries === null) {
    return DEFAULT_RETRY_POLICY;
  }

  if (typeof retries === 'number') {
    return {
      ...DEFAULT_RETRY_POLICY,
      maxAttempts: retries,
    };
  }

  if (typeof retries === 'object') {
    return {
      maxAttempts: retries.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
      initialIntervalMs: retries.initialIntervalMs ?? DEFAULT_RETRY_POLICY.initialIntervalMs,
      maxIntervalMs: retries.maxIntervalMs ?? DEFAULT_RETRY_POLICY.maxIntervalMs,
    };
  }

  throw new TypeError(`retries must be number or RetryPolicy, got ${typeof retries}`);
}

/**
 * Parse backoff configuration from various forms.
 *
 * @param backoff - Can be:
 *   - string: backoff type ("constant", "linear", "exponential")
 *   - BackoffPolicy: complete configuration
 *   - undefined: use default
 * @returns Complete BackoffPolicy
 *
 * @example
 * ```typescript
 * parseBackoffPolicy('exponential') // { type: 'exponential', multiplier: 2.0 }
 * parseBackoffPolicy({ type: 'linear', multiplier: 1.5 })
 * parseBackoffPolicy(undefined) // Uses defaults
 * ```
 */
export function parseBackoffPolicy(backoff?: string | BackoffPolicy): Required<BackoffPolicy> {
  if (backoff === undefined || backoff === null) {
    return DEFAULT_BACKOFF_POLICY;
  }

  if (typeof backoff === 'string') {
    const type = backoff.toLowerCase() as 'constant' | 'linear' | 'exponential';
    if (type !== 'constant' && type !== 'linear' && type !== 'exponential') {
      throw new TypeError(`backoff type must be "constant", "linear", or "exponential", got "${backoff}"`);
    }
    return {
      ...DEFAULT_BACKOFF_POLICY,
      type,
    };
  }

  if (typeof backoff === 'object') {
    return {
      type: backoff.type ?? DEFAULT_BACKOFF_POLICY.type,
      multiplier: backoff.multiplier ?? DEFAULT_BACKOFF_POLICY.multiplier,
    };
  }

  throw new TypeError(`backoff must be string or BackoffPolicy, got ${typeof backoff}`);
}

/**
 * Calculate backoff delay in milliseconds based on attempt number.
 *
 * @param attempt - Current attempt number (0-indexed)
 * @param retryPolicy - Retry configuration
 * @param backoffPolicy - Backoff configuration
 * @param jitter - Add jitter to prevent thundering herd (default: true)
 * @returns Delay in milliseconds
 *
 * @example
 * ```typescript
 * // Exponential backoff: 1s → 2s → 4s → 8s
 * calculateBackoffDelay(0, policy, { type: 'exponential', multiplier: 2.0 }) // ~1000ms
 * calculateBackoffDelay(1, policy, { type: 'exponential', multiplier: 2.0 }) // ~2000ms
 * calculateBackoffDelay(2, policy, { type: 'exponential', multiplier: 2.0 }) // ~4000ms
 *
 * // With jitter (adds randomness ±25%)
 * calculateBackoffDelay(1, policy, backoff, true) // ~1500ms - 2500ms
 * ```
 */
export function calculateBackoffDelay(
  attempt: number,
  retryPolicy: Required<RetryPolicy>,
  backoffPolicy: Required<BackoffPolicy>,
  jitter: boolean = true
): number {
  let delayMs: number;

  switch (backoffPolicy.type) {
    case 'constant':
      delayMs = retryPolicy.initialIntervalMs;
      break;

    case 'linear':
      delayMs = retryPolicy.initialIntervalMs * (attempt + 1);
      break;

    case 'exponential':
      delayMs = retryPolicy.initialIntervalMs * Math.pow(backoffPolicy.multiplier, attempt);
      break;

    default:
      throw new Error(`Unknown backoff type: ${(backoffPolicy as any).type}`);
  }

  // Cap at max_interval_ms
  delayMs = Math.min(delayMs, retryPolicy.maxIntervalMs);

  // Add jitter (±25% randomness) to prevent thundering herd
  if (jitter) {
    const jitterFactor = 0.25;
    const randomFactor = 1.0 + (Math.random() * 2.0 - 1.0) * jitterFactor;
    delayMs = Math.floor(delayMs * randomFactor);
  }

  return delayMs;
}

/**
 * Custom retry predicate function type.
 * Return true to retry, false to abort.
 */
export type RetryPredicate = (error: Error, attempt: number) => boolean;

/**
 * Options for executeWithRetry
 */
export interface ExecuteWithRetryOptions {
  /** Retry policy (attempts, intervals) */
  retryPolicy?: number | RetryPolicy;
  /** Backoff policy (type, multiplier) */
  backoffPolicy?: string | BackoffPolicy;
  /** Add jitter to backoff delays (default: true) */
  jitter?: boolean;
  /** Custom predicate to determine if retry should happen */
  retryPredicate?: RetryPredicate;
  /** Context for logging (optional) */
  context?: Context;
}

/**
 * Default retry predicate - always retry unless it's a specific non-retryable error
 */
const defaultRetryPredicate: RetryPredicate = (error: Error, _attempt: number): boolean => {
  // Import here to avoid circular dependency
  const errorName = error.constructor.name;

  // Don't retry these errors
  const nonRetryableErrors = [
    'ValidationError',
    'RunError',
    'TimeoutError',
    'AuthorizationError',
  ];

  return !nonRetryableErrors.includes(errorName);
};

/**
 * Execute a function with retry logic.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration options
 * @returns Result of successful execution
 * @throws RetryError if all retry attempts fail
 *
 * @example
 * ```typescript
 * // Simple retry with defaults (3 attempts, exponential backoff)
 * const result = await executeWithRetry(async () => {
 *   return await fetchData();
 * });
 *
 * // Custom retry policy
 * const result = await executeWithRetry(
 *   async () => await processData(),
 *   {
 *     retryPolicy: { maxAttempts: 5, initialIntervalMs: 2000 },
 *     backoffPolicy: 'linear',
 *     jitter: true,
 *   }
 * );
 *
 * // With custom retry predicate
 * const result = await executeWithRetry(
 *   async () => await callAPI(),
 *   {
 *     retryPolicy: 3,
 *     retryPredicate: (error, attempt) => {
 *       // Only retry on network errors
 *       return error.message.includes('ECONNREFUSED');
 *     },
 *   }
 * );
 * ```
 */
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  options: ExecuteWithRetryOptions = {}
): Promise<T> {
  const retryPolicy = parseRetryPolicy(options.retryPolicy);
  const backoffPolicy = parseBackoffPolicy(options.backoffPolicy);
  const jitter = options.jitter ?? true;
  const retryPredicate = options.retryPredicate ?? defaultRetryPredicate;
  const context = options.context;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < retryPolicy.maxAttempts; attempt++) {
    try {
      const result = await fn();
      return result;
    } catch (error) {
      lastError = error as Error;

      // Log error if context provided
      if (context) {
        context.logger.warn(
          `Execution failed (attempt ${attempt + 1}/${retryPolicy.maxAttempts}): ${lastError.message}`
        );
      }

      // Check if we should retry
      const shouldRetry = retryPredicate(lastError, attempt);
      if (!shouldRetry) {
        if (context) {
          context.logger.error(`Non-retryable error encountered: ${lastError.message}`);
        }
        throw lastError;
      }

      // If this was the last attempt, throw RetryError
      if (attempt === retryPolicy.maxAttempts - 1) {
        throw new RetryError(
          `Execution failed after ${retryPolicy.maxAttempts} attempts: ${lastError.message}`,
          retryPolicy.maxAttempts,
          lastError
        );
      }

      // Calculate backoff delay
      const delayMs = calculateBackoffDelay(attempt, retryPolicy, backoffPolicy, jitter);

      if (context) {
        context.logger.info(`Retrying in ${delayMs}ms...`);
      }

      // Wait before next attempt
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  // Should never reach here, but for type safety
  throw new RetryError(
    `Execution failed after ${retryPolicy.maxAttempts} attempts`,
    retryPolicy.maxAttempts,
    lastError
  );
}

/**
 * Create a retry wrapper function for repeated use.
 *
 * @param options - Retry configuration options
 * @returns Function that executes with retry logic
 *
 * @example
 * ```typescript
 * const retryableFetch = createRetryWrapper({
 *   retryPolicy: 5,
 *   backoffPolicy: 'exponential',
 * });
 *
 * const data1 = await retryableFetch(() => fetch('/api/data1'));
 * const data2 = await retryableFetch(() => fetch('/api/data2'));
 * ```
 */
export function createRetryWrapper(options: ExecuteWithRetryOptions = {}) {
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    return executeWithRetry(fn, options);
  };
}

/**
 * Retry with timeout - execute with retry logic and overall timeout.
 *
 * @param fn - The async function to execute
 * @param timeoutMs - Maximum time to spend retrying (in milliseconds)
 * @param options - Retry configuration options
 * @returns Result of successful execution
 * @throws TimeoutError if timeout is exceeded
 * @throws RetryError if all retry attempts fail
 *
 * @example
 * ```typescript
 * // Retry for up to 30 seconds
 * const result = await executeWithRetryAndTimeout(
 *   async () => await processData(),
 *   30000, // 30 seconds
 *   { retryPolicy: 10 }
 * );
 * ```
 */
export async function executeWithRetryAndTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  options: ExecuteWithRetryOptions = {}
): Promise<T> {
  const startTime = Date.now();

  // Wrap the predicate to check timeout
  const originalPredicate = options.retryPredicate ?? defaultRetryPredicate;
  const timeoutPredicate: RetryPredicate = (error: Error, attempt: number): boolean => {
    const elapsed = Date.now() - startTime;
    if (elapsed >= timeoutMs) {
      return false; // Don't retry if timeout exceeded
    }
    return originalPredicate(error, attempt);
  };

  try {
    return await executeWithRetry(fn, {
      ...options,
      retryPredicate: timeoutPredicate,
    });
  } catch (error) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= timeoutMs) {
      const { TimeoutError } = await import('./errors.js');
      throw new TimeoutError(`Execution timed out after ${timeoutMs}ms`, timeoutMs, 'executeWithRetryAndTimeout');
    }
    throw error;
  }
}
