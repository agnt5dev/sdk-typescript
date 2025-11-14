/**
 * Test suite for retry utilities
 *
 * Run with: npx tsx test-retry-utils.ts
 */

import {
  parseRetryPolicy,
  parseBackoffPolicy,
  calculateBackoffDelay,
  executeWithRetry,
  createRetryWrapper,
  executeWithRetryAndTimeout,
  DEFAULT_RETRY_POLICY,
  DEFAULT_BACKOFF_POLICY,
} from './src/retry-utils.js';
import { RetryError, ValidationError } from './src/errors.js';

// Test counter for tracking
let testsPassed = 0;
let testsFailed = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${message}`);
    testsFailed++;
    throw new Error(message);
  }
  testsPassed++;
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    console.error(`❌ ${message}: expected ${expected}, got ${actual}`);
    testsFailed++;
    throw new Error(message);
  }
  testsPassed++;
}

// Test 1: Parse retry policy
async function testParseRetryPolicy() {
  console.log('\n📋 Test 1: Parse Retry Policy');

  // Test with number
  const policy1 = parseRetryPolicy(5);
  assertEqual(policy1.maxAttempts, 5, 'maxAttempts from number');
  assertEqual(policy1.initialIntervalMs, 1000, 'initialIntervalMs default');
  assertEqual(policy1.maxIntervalMs, 60000, 'maxIntervalMs default');

  // Test with object
  const policy2 = parseRetryPolicy({ maxAttempts: 3, initialIntervalMs: 2000 });
  assertEqual(policy2.maxAttempts, 3, 'maxAttempts from object');
  assertEqual(policy2.initialIntervalMs, 2000, 'initialIntervalMs from object');
  assertEqual(policy2.maxIntervalMs, 60000, 'maxIntervalMs default in object');

  // Test with undefined (defaults)
  const policy3 = parseRetryPolicy(undefined);
  assertEqual(policy3.maxAttempts, 3, 'default maxAttempts');
  assertEqual(policy3.initialIntervalMs, 1000, 'default initialIntervalMs');
  assertEqual(policy3.maxIntervalMs, 60000, 'default maxIntervalMs');

  console.log('✅ Parse Retry Policy: All tests passed');
}

// Test 2: Parse backoff policy
async function testParseBackoffPolicy() {
  console.log('\n📋 Test 2: Parse Backoff Policy');

  // Test with string
  const policy1 = parseBackoffPolicy('exponential');
  assertEqual(policy1.type, 'exponential', 'type from string');
  assertEqual(policy1.multiplier, 2.0, 'multiplier default');

  // Test with object
  const policy2 = parseBackoffPolicy({ type: 'linear', multiplier: 1.5 });
  assertEqual(policy2.type, 'linear', 'type from object');
  assertEqual(policy2.multiplier, 1.5, 'multiplier from object');

  // Test with undefined (defaults)
  const policy3 = parseBackoffPolicy(undefined);
  assertEqual(policy3.type, 'exponential', 'default type');
  assertEqual(policy3.multiplier, 2.0, 'default multiplier');

  console.log('✅ Parse Backoff Policy: All tests passed');
}

// Test 3: Calculate backoff delay
async function testCalculateBackoffDelay() {
  console.log('\n📋 Test 3: Calculate Backoff Delay');

  const retryPolicy = parseRetryPolicy({ maxAttempts: 5, initialIntervalMs: 1000, maxIntervalMs: 10000 });

  // Test constant backoff (no jitter for predictable results)
  const constantPolicy = parseBackoffPolicy({ type: 'constant', multiplier: 1.0 });
  const delay1 = calculateBackoffDelay(0, retryPolicy, constantPolicy, false);
  const delay2 = calculateBackoffDelay(1, retryPolicy, constantPolicy, false);
  const delay3 = calculateBackoffDelay(2, retryPolicy, constantPolicy, false);

  assertEqual(delay1, 1000, 'constant backoff attempt 0');
  assertEqual(delay2, 1000, 'constant backoff attempt 1');
  assertEqual(delay3, 1000, 'constant backoff attempt 2');

  // Test linear backoff (no jitter)
  const linearPolicy = parseBackoffPolicy({ type: 'linear', multiplier: 1.0 });
  const delay4 = calculateBackoffDelay(0, retryPolicy, linearPolicy, false);
  const delay5 = calculateBackoffDelay(1, retryPolicy, linearPolicy, false);
  const delay6 = calculateBackoffDelay(2, retryPolicy, linearPolicy, false);

  assertEqual(delay4, 1000, 'linear backoff attempt 0 (1x)');
  assertEqual(delay5, 2000, 'linear backoff attempt 1 (2x)');
  assertEqual(delay6, 3000, 'linear backoff attempt 2 (3x)');

  // Test exponential backoff (no jitter)
  const exponentialPolicy = parseBackoffPolicy({ type: 'exponential', multiplier: 2.0 });
  const delay7 = calculateBackoffDelay(0, retryPolicy, exponentialPolicy, false);
  const delay8 = calculateBackoffDelay(1, retryPolicy, exponentialPolicy, false);
  const delay9 = calculateBackoffDelay(2, retryPolicy, exponentialPolicy, false);

  assertEqual(delay7, 1000, 'exponential backoff attempt 0 (2^0 = 1)');
  assertEqual(delay8, 2000, 'exponential backoff attempt 1 (2^1 = 2)');
  assertEqual(delay9, 4000, 'exponential backoff attempt 2 (2^2 = 4)');

  // Test max interval cap
  const delay10 = calculateBackoffDelay(10, retryPolicy, exponentialPolicy, false);
  assert(delay10 <= 10000, 'capped at maxIntervalMs');

  // Test jitter (should be within ±25%)
  const delayWithJitter = calculateBackoffDelay(1, retryPolicy, exponentialPolicy, true);
  const expected = 2000;
  const minExpected = expected * 0.75;
  const maxExpected = expected * 1.25;
  assert(delayWithJitter >= minExpected && delayWithJitter <= maxExpected,
    `jitter within range: ${delayWithJitter} should be between ${minExpected} and ${maxExpected}`);

  console.log('✅ Calculate Backoff Delay: All tests passed');
}

// Test 4: Execute with retry - success on first attempt
async function testExecuteWithRetrySuccess() {
  console.log('\n📋 Test 4: Execute With Retry - Success');

  let attempts = 0;
  const fn = async () => {
    attempts++;
    return 'success';
  };

  const result = await executeWithRetry(fn, {
    retryPolicy: 3,
    jitter: false,
  });

  assertEqual(result, 'success', 'returns success result');
  assertEqual(attempts, 1, 'only 1 attempt needed');

  console.log('✅ Execute With Retry - Success: All tests passed');
}

// Test 5: Execute with retry - eventual success
async function testExecuteWithRetryEventualSuccess() {
  console.log('\n📋 Test 5: Execute With Retry - Eventual Success');

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

  assertEqual(result, 'success', 'returns success result after retries');
  assertEqual(attempts, 3, '3 attempts needed');

  console.log('✅ Execute With Retry - Eventual Success: All tests passed');
}

// Test 6: Execute with retry - all attempts fail
async function testExecuteWithRetryAllFail() {
  console.log('\n📋 Test 6: Execute With Retry - All Attempts Fail');

  let attempts = 0;
  const fn = async () => {
    attempts++;
    throw new Error('Persistent failure');
  };

  let caughtError: Error | null = null;
  try {
    await executeWithRetry(fn, {
      retryPolicy: 3,
      backoffPolicy: { type: 'constant', multiplier: 1.0 },
      jitter: false,
    });
  } catch (error) {
    caughtError = error as Error;
  }

  assert(caughtError instanceof RetryError, 'throws RetryError');
  assertEqual(attempts, 3, 'all 3 attempts exhausted');
  assert(caughtError!.message.includes('after 3 attempts'), 'error message mentions attempts');

  console.log('✅ Execute With Retry - All Attempts Fail: All tests passed');
}

// Test 7: Execute with retry - non-retryable error
async function testExecuteWithRetryNonRetryable() {
  console.log('\n📋 Test 7: Execute With Retry - Non-Retryable Error');

  let attempts = 0;
  const fn = async () => {
    attempts++;
    throw new ValidationError('Invalid input');
  };

  let caughtError: Error | null = null;
  try {
    await executeWithRetry(fn, {
      retryPolicy: 5,
    });
  } catch (error) {
    caughtError = error as Error;
  }

  assert(caughtError instanceof ValidationError, 'throws original ValidationError');
  assertEqual(attempts, 1, 'only 1 attempt (no retries for ValidationError)');

  console.log('✅ Execute With Retry - Non-Retryable Error: All tests passed');
}

// Test 8: Execute with retry - custom predicate
async function testExecuteWithRetryCustomPredicate() {
  console.log('\n📋 Test 8: Execute With Retry - Custom Predicate');

  let attempts = 0;
  const fn = async () => {
    attempts++;
    throw new Error('ECONNREFUSED');
  };

  let caughtError: Error | null = null;
  try {
    await executeWithRetry(fn, {
      retryPolicy: 5,
      backoffPolicy: 'constant',
      jitter: false,
      retryPredicate: (error, attempt) => {
        // Only retry if error message contains ECONNREFUSED
        return error.message.includes('ECONNREFUSED');
      },
    });
  } catch (error) {
    caughtError = error as Error;
  }

  assert(caughtError instanceof RetryError, 'throws RetryError');
  assertEqual(attempts, 5, 'all 5 attempts used (custom predicate allows retry)');

  console.log('✅ Execute With Retry - Custom Predicate: All tests passed');
}

// Test 9: Create retry wrapper
async function testCreateRetryWrapper() {
  console.log('\n📋 Test 9: Create Retry Wrapper');

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

  assertEqual(result, 'wrapped-success', 'wrapper returns result');
  assertEqual(attempts, 2, 'wrapper used retry logic');

  console.log('✅ Create Retry Wrapper: All tests passed');
}

// Test 10: Execute with retry and timeout
async function testExecuteWithRetryAndTimeout() {
  console.log('\n📋 Test 10: Execute With Retry And Timeout');

  // Test success before timeout
  let attempts1 = 0;
  const result = await executeWithRetryAndTimeout(
    async () => {
      attempts1++;
      if (attempts1 < 2) {
        throw new Error('Temporary');
      }
      return 'timeout-success';
    },
    5000, // 5 second timeout
    {
      retryPolicy: { maxAttempts: 5, initialIntervalMs: 100, maxIntervalMs: 1000 },
      backoffPolicy: 'constant',
      jitter: false,
    }
  );

  assertEqual(result, 'timeout-success', 'returns result before timeout');
  assertEqual(attempts1, 2, 'attempts before success');

  console.log('✅ Execute With Retry And Timeout: All tests passed');
}

// Test 11: Execute with timeout exceeded
async function testExecuteWithTimeoutExceeded() {
  console.log('\n📋 Test 11: Execute With Timeout Exceeded');

  let attempts = 0;
  let caughtError: Error | null = null;

  try {
    await executeWithRetryAndTimeout(
      async () => {
        attempts++;
        await new Promise(resolve => setTimeout(resolve, 100));
        throw new Error('Still failing');
      },
      500, // 500ms timeout
      {
        retryPolicy: { maxAttempts: 100, initialIntervalMs: 100, maxIntervalMs: 200 },
        backoffPolicy: 'constant',
        jitter: false,
      }
    );
  } catch (error) {
    caughtError = error as Error;
  }

  assert(caughtError !== null, 'error thrown');
  assert(caughtError!.constructor.name === 'TimeoutError' ||
         caughtError instanceof RetryError, 'throws timeout-related error');
  assert(attempts < 100, 'stopped before max attempts due to timeout');

  console.log('✅ Execute With Timeout Exceeded: All tests passed');
}

// Main test runner
async function runTests() {
  console.log('🧪 Running Retry Utilities Tests\n');
  console.log('='.repeat(60));

  try {
    await testParseRetryPolicy();
    await testParseBackoffPolicy();
    await testCalculateBackoffDelay();
    await testExecuteWithRetrySuccess();
    await testExecuteWithRetryEventualSuccess();
    await testExecuteWithRetryAllFail();
    await testExecuteWithRetryNonRetryable();
    await testExecuteWithRetryCustomPredicate();
    await testCreateRetryWrapper();
    await testExecuteWithRetryAndTimeout();
    await testExecuteWithTimeoutExceeded();

    console.log('\n' + '='.repeat(60));
    console.log(`\n✅ All tests passed! (${testsPassed} assertions)`);
    console.log(`❌ Failed: ${testsFailed}`);
    process.exit(0);
  } catch (error) {
    console.error('\n' + '='.repeat(60));
    console.error(`\n❌ Test suite failed: ${error}`);
    console.error(`✅ Passed: ${testsPassed}`);
    console.error(`❌ Failed: ${testsFailed}`);
    process.exit(1);
  }
}

// Run tests
runTests();
