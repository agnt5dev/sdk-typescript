import { describe, it, expect, beforeEach } from 'vitest';
import { fn, FunctionRegistry } from '../function';
import { ContextImpl } from '../context';

describe('Function Builder', () => {
  beforeEach(() => {
    // Clear registry before each test
    FunctionRegistry.clear();
  });

  it('should create a function', () => {
    const greet = fn('greet').run(async (ctx, name: string) => {
      return `Hello, ${name}!`;
    });

    expect(greet).toBeDefined();
    expect(typeof greet).toBe('function');
  });

  it('should register function in registry', () => {
    fn('test-func').run(async (ctx) => 'result');

    const registered = FunctionRegistry.get('test-func');
    expect(registered).toBeDefined();
    expect(registered?.handler).toBeDefined();
  });

  it('should accept retry configuration', () => {
    const retryable = fn('retryable')
      .retry({ maxAttempts: 3, initialIntervalMs: 1000 })
      .backoff({ type: 'exponential', multiplier: 2.0 })
      .run(async (ctx, data: string) => {
        return data;
      });

    expect(retryable).toBeDefined();

    const registered = FunctionRegistry.get('retryable');
    expect(registered?.options.retries?.maxAttempts).toBe(3);
    expect(registered?.options.backoff?.type).toBe('exponential');
  });

  it('should execute function with context', async () => {
    const greet = fn('greet').run(async (ctx, name: string) => {
      ctx.logger.info(`Greeting ${name}`);
      return `Hello, ${name}!`;
    });

    const ctx = new ContextImpl('inv-1', 'run-1', 0, 'test-service');
    const result = await greet(ctx, 'World');

    expect(result).toBe('Hello, World!');
  });
});
