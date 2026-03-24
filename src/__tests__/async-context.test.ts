import { describe, it, expect } from 'vitest';
import { runWithContext, getCurrentContext, requireContext } from '../async-context.js';

describe('AsyncContext Propagation', () => {
  it('should propagate context through sync code', () => {
    runWithContext({ runId: 'run-1' }, () => {
      const ctx = getCurrentContext();
      expect(ctx).toBeDefined();
      expect(ctx!.runId).toBe('run-1');
    });
  });

  it('should propagate context through async code', async () => {
    await runWithContext({ runId: 'run-2', sessionId: 'sess-1' }, async () => {
      // Simulate async work
      await new Promise(resolve => setTimeout(resolve, 5));
      const ctx = getCurrentContext();
      expect(ctx).toBeDefined();
      expect(ctx!.runId).toBe('run-2');
      expect(ctx!.sessionId).toBe('sess-1');
    });
  });

  it('should propagate through nested async calls', async () => {
    await runWithContext(
      { runId: 'run-3', userId: 'user-42', correlationId: 'corr-1' },
      async () => {
        // Nested function call
        const result = await innerFunction();
        expect(result).toBe('user-42');
      },
    );

    async function innerFunction(): Promise<string | undefined> {
      await new Promise(resolve => setTimeout(resolve, 1));
      const ctx = getCurrentContext();
      return ctx?.userId;
    }
  });

  it('should return undefined outside context scope', () => {
    const ctx = getCurrentContext();
    expect(ctx).toBeUndefined();
  });

  it('should throw on requireContext() outside scope', () => {
    expect(() => requireContext()).toThrow('No propagated context available');
  });

  it('should not leak context between concurrent runs', async () => {
    const results: string[] = [];

    await Promise.all([
      runWithContext({ runId: 'A' }, async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        results.push(getCurrentContext()!.runId);
      }),
      runWithContext({ runId: 'B' }, async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        results.push(getCurrentContext()!.runId);
      }),
    ]);

    // B finishes first due to shorter delay
    expect(results).toContain('A');
    expect(results).toContain('B');
    expect(results).toHaveLength(2);
  });

  it('should support nested context (inner overrides outer)', async () => {
    await runWithContext({ runId: 'outer', userId: 'user-1' }, async () => {
      expect(getCurrentContext()!.runId).toBe('outer');

      await runWithContext({ runId: 'inner', userId: 'user-2' }, async () => {
        const ctx = getCurrentContext()!;
        expect(ctx.runId).toBe('inner');
        expect(ctx.userId).toBe('user-2');
      });

      // Back to outer context
      expect(getCurrentContext()!.runId).toBe('outer');
      expect(getCurrentContext()!.userId).toBe('user-1');
    });
  });

  it('should propagate metadata and tenantId', async () => {
    await runWithContext(
      {
        runId: 'run-meta',
        tenantId: 'tenant-abc',
        metadata: { source: 'api', priority: 'high' },
      },
      async () => {
        const ctx = getCurrentContext()!;
        expect(ctx.tenantId).toBe('tenant-abc');
        expect(ctx.metadata?.source).toBe('api');
        expect(ctx.metadata?.priority).toBe('high');
      },
    );
  });
});
