import { describe, it, expect, beforeEach } from 'vitest';
import { entity, _clearEntityState, _getEntityState, _setEntityStorage } from '../entity.js';

describe('Entity', () => {
  beforeEach(() => {
    // Force in-memory storage for tests by resetting global storage
    // Setting to null forces getGlobalStorage() to create a fresh instance
    process.env.AGNT5_STORAGE = 'memory';
    _setEntityStorage(null);
  });

  it('should create entity type and instances', () => {
    const Counter = entity('Counter');
    const instance = Counter.call('key-1');

    expect(instance.getEntityType()).toBe('Counter');
    expect(instance.getKey()).toBe('key-1');
  });

  it('should register and invoke entity methods', async () => {
    const Counter = entity('Counter');

    Counter.method('increment', async (ctx, amount: number = 1) => {
      const current = await ctx.get<number>('count', 0);
      const newCount = current! + amount;
      await ctx.set('count', newCount);
      return newCount;
    });

    Counter.method('getCount', async (ctx) => {
      return await ctx.get<number>('count', 0);
    });

    const counter = Counter.call('test');

    const result1 = await counter.invoke('increment', 5);
    expect(result1).toBe(5);

    const result2 = await counter.invoke('increment', 3);
    expect(result2).toBe(8);

    const count = await counter.invoke('getCount');
    expect(count).toBe(8);
  });

  it('should maintain isolated state per key', async () => {
    const Counter = entity('Counter');

    Counter.method('increment', async (ctx, amount: number = 1) => {
      const current = await ctx.get<number>('count', 0);
      const newCount = current! + amount;
      await ctx.set('count', newCount);
      return newCount;
    });

    const counter1 = Counter.call('user-1');
    const counter2 = Counter.call('user-2');

    await counter1.invoke('increment', 10);
    await counter2.invoke('increment', 5);

    const state1 = await _getEntityState('Counter', 'user-1');
    const state2 = await _getEntityState('Counter', 'user-2');

    expect(state1?.get('count')).toBe(10);
    expect(state2?.get('count')).toBe(5);
  });

  it('should throw error for non-existent method', async () => {
    const Counter = entity('Counter');
    const instance = Counter.call('test');

    await expect(instance.invoke('nonExistent')).rejects.toThrow(
      "has no method 'nonExistent'"
    );
  });

  it('should handle concurrent operations with single-writer guarantee', async () => {
    const Counter = entity('Counter');

    Counter.method('increment', async (ctx) => {
      const current = await ctx.get<number>('count', 0);
      // Simulate some async work
      await new Promise(resolve => setTimeout(resolve, 10));
      await ctx.set('count', current! + 1);
      return current! + 1;
    });

    const counter = Counter.call('concurrent');

    // Run 5 increments concurrently
    await Promise.all([
      counter.invoke('increment'),
      counter.invoke('increment'),
      counter.invoke('increment'),
      counter.invoke('increment'),
      counter.invoke('increment')
    ]);

    const state = await _getEntityState('Counter', 'concurrent');
    expect(state?.get('count')).toBe(5);
  });
});
