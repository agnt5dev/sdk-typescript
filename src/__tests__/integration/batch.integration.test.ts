/**
 * Integration test: Batch operations
 *
 * Tests batch execution of components against a running platform.
 *
 * Requires a running AGNT5 platform.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createTestClient, skipIfNoPlatform, uniqueName } from './helpers.js';

describe.skip('Integration: Batch operations', () => {
  beforeAll(async () => {
    await skipIfNoPlatform();
  });

  it('should execute batch of functions', async () => {
    const client = createTestClient();

    const result = await client.batch('greet', [
      { input: { name: 'Alice' } },
      { input: { name: 'Bob' } },
      { input: { name: 'Charlie' } },
    ], { maxConcurrency: 3 });

    expect(result.isSuccess).toBe(true);
    expect(result.outputs).toHaveLength(3);
  });

  it('should handle partial failures in batch', async () => {
    const client = createTestClient();

    const result = await client.batch('maybe-fail', [
      { input: { shouldFail: false } },
      { input: { shouldFail: true } },
      { input: { shouldFail: false } },
    ], { maxConcurrency: 3 });

    expect(result.successfulOutputs().length).toBeGreaterThan(0);
  });
});
