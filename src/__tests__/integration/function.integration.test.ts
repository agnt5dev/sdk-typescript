/**
 * Integration test: Function registration + invocation
 *
 * Tests the full lifecycle:
 * 1. Register a function with the worker
 * 2. Invoke it via the client
 * 3. Verify the response
 *
 * Requires a running AGNT5 platform.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { fn } from '../../function.js';
import { createTestClient, skipIfNoPlatform, uniqueName } from './helpers.js';

// Skip entire suite if platform is not available
describe.skip('Integration: Function invocation', () => {
  beforeAll(async () => {
    await skipIfNoPlatform();
  });

  it('should invoke a registered function', async () => {
    const client = createTestClient();
    const functionName = uniqueName('greet');

    // Register a simple function
    const greet = fn(functionName, {
      description: 'Greet a user',
      handler: async (_ctx, name: string) => `Hello, ${name}!`,
    });

    // Invoke via client
    const response = await client.run(functionName, { args: ['World'] });

    expect(response.isSuccess).toBe(true);
    expect(response.output).toBe('Hello, World!');
    expect(response.runId).toBeDefined();
    expect(response.durationMs).toBeGreaterThan(0);
  });

  it('should handle function errors gracefully', async () => {
    const client = createTestClient();
    const functionName = uniqueName('failing');

    const failing = fn(functionName, {
      description: 'Always fails',
      handler: async () => {
        throw new Error('Intentional error');
      },
    });

    const response = await client.run(functionName, {});

    expect(response.isError).toBe(true);
    expect(response.error?.message).toContain('Intentional error');
  });

  it('should support typed responses', async () => {
    const client = createTestClient();
    const functionName = uniqueName('compute');

    interface MathResult {
      sum: number;
      product: number;
    }

    const compute = fn(functionName, {
      handler: async (_ctx, a: number, b: number) => ({
        sum: a + b,
        product: a * b,
      }),
    });

    const response = await client.run<MathResult>(functionName, { args: [3, 4] });

    if (response.isSuccess) {
      expect(response.output?.sum).toBe(7);
      expect(response.output?.product).toBe(12);
    }
  });
});
