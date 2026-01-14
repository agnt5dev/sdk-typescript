import { describe, it, expect } from 'vitest';
import { fn } from '../function.js';
import { Worker } from '../worker.js';

describe('Worker Integration', () => {
  it('should define functions for worker', () => {
    const greet = fn('greet').run(async (ctx, name: string) => {
      ctx.logger.info(`Greeting ${name}`);
      return `Hello, ${name}!`;
    });

    const add = fn('add').run(async (ctx, a: number, b: number) => {
      ctx.logger.info(`Adding ${a} + ${b}`);
      return a + b;
    });

    expect(greet).toBeDefined();
    expect(add).toBeDefined();
  });

  it.skip('should start worker and connect to platform', async () => {
    // Integration test - requires platform connectivity
    // Skipped in unit tests, run manually for integration testing
    const worker = new Worker('test-typescript-worker', {
      serviceVersion: '0.1.0',
      serviceType: 'function',
    });

    await expect(worker.run()).resolves.not.toThrow();
  });
});
