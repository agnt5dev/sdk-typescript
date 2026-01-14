import { describe, it, expect } from 'vitest';
import {
  parseRetryPolicy,
  parseBackoffPolicy,
  calculateBackoffDelay,
  executeWithRetry,
  createRetryWrapper,
  executeWithRetryAndTimeout,
} from '../retry-utils.js';
import { RetryError, ValidationError } from '../errors.js';

describe('Retry Utilities', () => {
  describe('parseRetryPolicy', () => {
    it('should parse policy from number', () => {
      const policy = parseRetryPolicy(5);
      expect(policy.maxAttempts).toBe(5);
      expect(policy.initialIntervalMs).toBe(1000);
      expect(policy.maxIntervalMs).toBe(60000);
    });

    it('should parse policy from object', () => {
      const policy = parseRetryPolicy({ maxAttempts: 3, initialIntervalMs: 2000 });
      expect(policy.maxAttempts).toBe(3);
      expect(policy.initialIntervalMs).toBe(2000);
      expect(policy.maxIntervalMs).toBe(60000);
    });

    it('should use defaults when undefined', () => {
      const policy = parseRetryPolicy(undefined);
      expect(policy.maxAttempts).toBe(3);
      expect(policy.initialIntervalMs).toBe(1000);
      expect(policy.maxIntervalMs).toBe(60000);
    });
  });

  describe('parseBackoffPolicy', () => {
    it('should parse policy from string', () => {
      const policy = parseBackoffPolicy('exponential');
      expect(policy.type).toBe('exponential');
      expect(policy.multiplier).toBe(2.0);
    });

    it('should parse policy from object', () => {
      const policy = parseBackoffPolicy({ type: 'linear', multiplier: 1.5 });
      expect(policy.type).toBe('linear');
      expect(policy.multiplier).toBe(1.5);
    });

    it('should use defaults when undefined', () => {
      const policy = parseBackoffPolicy(undefined);
      expect(policy.type).toBe('exponential');
      expect(policy.multiplier).toBe(2.0);
    });
  });

  describe('calculateBackoffDelay', () => {
    const retryPolicy = parseRetryPolicy({ maxAttempts: 5, initialIntervalMs: 1000, maxIntervalMs: 10000 });

    it('should calculate constant backoff', () => {
      const constantPolicy = parseBackoffPolicy({ type: 'constant', multiplier: 1.0 });

      expect(calculateBackoffDelay(0, retryPolicy, constantPolicy, false)).toBe(1000);
      expect(calculateBackoffDelay(1, retryPolicy, constantPolicy, false)).toBe(1000);
      expect(calculateBackoffDelay(2, retryPolicy, constantPolicy, false)).toBe(1000);
    });

    it('should calculate linear backoff', () => {
      const linearPolicy = parseBackoffPolicy({ type: 'linear', multiplier: 1.0 });

      expect(calculateBackoffDelay(0, retryPolicy, linearPolicy, false)).toBe(1000);
      expect(calculateBackoffDelay(1, retryPolicy, linearPolicy, false)).toBe(2000);
      expect(calculateBackoffDelay(2, retryPolicy, linearPolicy, false)).toBe(3000);
    });

    it('should calculate exponential backoff', () => {
      const exponentialPolicy = parseBackoffPolicy({ type: 'exponential', multiplier: 2.0 });

      expect(calculateBackoffDelay(0, retryPolicy, exponentialPolicy, false)).toBe(1000);
      expect(calculateBackoffDelay(1, retryPolicy, exponentialPolicy, false)).toBe(2000);
      expect(calculateBackoffDelay(2, retryPolicy, exponentialPolicy, false)).toBe(4000);
    });

    it('should cap delay at maxIntervalMs', () => {
      const exponentialPolicy = parseBackoffPolicy({ type: 'exponential', multiplier: 2.0 });
      const delay = calculateBackoffDelay(10, retryPolicy, exponentialPolicy, false);
      expect(delay).toBeLessThanOrEqual(10000);
    });

    it('should apply jitter within ±25%', () => {
      const exponentialPolicy = parseBackoffPolicy({ type: 'exponential', multiplier: 2.0 });
      const delayWithJitter = calculateBackoffDelay(1, retryPolicy, exponentialPolicy, true);
      const expected = 2000;
      const minExpected = expected * 0.75;
      const maxExpected = expected * 1.25;

      expect(delayWithJitter).toBeGreaterThanOrEqual(minExpected);
      expect(delayWithJitter).toBeLessThanOrEqual(maxExpected);
    });
  });

  describe('executeWithRetry', () => {
    it('should succeed on first attempt', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        return 'success';
      };

      const result = await executeWithRetry(fn, {
        retryPolicy: 3,
        jitter: false,
      });

      expect(result).toBe('success');
      expect(attempts).toBe(1);
    });

    it('should retry and eventually succeed', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Temporary failure');
        }
        return 'success';
      };

      const result = await executeWithRetry(fn, {
        retryPolicy: { maxAttempts: 5, initialIntervalMs: 100, maxIntervalMs: 1000 },
        backoffPolicy: 'constant',
        jitter: false,
      });

      expect(result).toBe('success');
      expect(attempts).toBe(3);
    });

    it('should throw RetryError when all attempts fail', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        throw new Error('Persistent failure');
      };

      await expect(
        executeWithRetry(fn, {
          retryPolicy: 3,
          backoffPolicy: { type: 'constant', multiplier: 1.0 },
          jitter: false,
        })
      ).rejects.toThrow(RetryError);

      expect(attempts).toBe(3);
    });

    it('should not retry non-retryable errors', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        throw new ValidationError('Invalid input');
      };

      await expect(
        executeWithRetry(fn, {
          retryPolicy: 5,
        })
      ).rejects.toThrow(ValidationError);

      expect(attempts).toBe(1);
    });

    it('should respect custom retry predicate', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        throw new Error('ECONNREFUSED');
      };

      await expect(
        executeWithRetry(fn, {
          retryPolicy: 5,
          backoffPolicy: 'constant',
          jitter: false,
          retryPredicate: (error, attempt) => {
            return error.message.includes('ECONNREFUSED');
          },
        })
      ).rejects.toThrow(RetryError);

      expect(attempts).toBe(5);
    });
  });

  describe('createRetryWrapper', () => {
    it('should wrap function with retry logic', async () => {
      const retryWrapper = createRetryWrapper({
        retryPolicy: { maxAttempts: 3, initialIntervalMs: 100, maxIntervalMs: 1000 },
        backoffPolicy: 'constant',
        jitter: false,
      });

      let attempts = 0;
      const result = await retryWrapper(async () => {
        attempts++;
        if (attempts < 2) {
          throw new Error('Temporary');
        }
        return 'wrapped-success';
      });

      expect(result).toBe('wrapped-success');
      expect(attempts).toBe(2);
    });
  });

  describe('executeWithRetryAndTimeout', () => {
    it('should succeed before timeout', async () => {
      let attempts = 0;
      const result = await executeWithRetryAndTimeout(
        async () => {
          attempts++;
          if (attempts < 2) {
            throw new Error('Temporary');
          }
          return 'timeout-success';
        },
        5000,
        {
          retryPolicy: { maxAttempts: 5, initialIntervalMs: 100, maxIntervalMs: 1000 },
          backoffPolicy: 'constant',
          jitter: false,
        }
      );

      expect(result).toBe('timeout-success');
      expect(attempts).toBe(2);
    });

    it('should throw error when timeout exceeded', async () => {
      let attempts = 0;

      await expect(
        executeWithRetryAndTimeout(
          async () => {
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 100));
            throw new Error('Still failing');
          },
          500,
          {
            retryPolicy: { maxAttempts: 100, initialIntervalMs: 100, maxIntervalMs: 200 },
            backoffPolicy: 'constant',
            jitter: false,
          }
        )
      ).rejects.toThrow();

      expect(attempts).toBeLessThan(100);
    });
  });
});
