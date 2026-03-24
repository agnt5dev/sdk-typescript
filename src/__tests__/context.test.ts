import { describe, it, expect } from 'vitest';
import { ContextImpl } from '../context';

describe('Context', () => {
  it('should create context with metadata', () => {
    const ctx = new ContextImpl('inv-123', 'run-456', 2, 'my-service', { storage: 'memory' });

    expect(ctx.invocationId).toBe('inv-123');
    expect(ctx.runId).toBe('run-456');
    expect(ctx.attempt).toBe(2);
    expect(ctx.serviceName).toBe('my-service');
  });

  it('should manage state', async () => {
    const ctx = new ContextImpl('inv-1', 'run-1', 0, 'test', { storage: 'memory' });

    // Set and get
    await ctx.set('key1', 'value1');
    expect(await ctx.get('key1')).toBe('value1');

    // Get with default
    expect(await ctx.get('missing', 'default')).toBe('default');

    // Delete
    await ctx.delete('key1');
    expect(await ctx.get('key1')).toBeUndefined();
  });

  it('should checkpoint steps', async () => {
    const ctx = new ContextImpl('inv-1', 'run-1', 0, 'test', { storage: 'memory' });

    let executionCount = 0;
    const expensiveOp = () => {
      executionCount++;
      return 'result';
    };

    // First execution
    const result1 = await ctx.step('step1', expensiveOp);
    expect(result1).toBe('result');
    expect(executionCount).toBe(1);

    // Second execution (should use checkpoint)
    const result2 = await ctx.step('step1', expensiveOp);
    expect(result2).toBe('result');
    expect(executionCount).toBe(1); // Should not execute again
  });

  it('should provide logger', () => {
    const ctx = new ContextImpl('inv-1', 'run-1', 0, 'test', { storage: 'memory' });

    expect(ctx.logger).toBeDefined();
    expect(typeof ctx.logger.info).toBe('function');
    expect(typeof ctx.logger.error).toBe('function');
    expect(typeof ctx.logger.warn).toBe('function');
    expect(typeof ctx.logger.debug).toBe('function');
  });
});
