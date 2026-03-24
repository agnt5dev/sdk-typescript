import { describe, it, expect, vi } from 'vitest';
import {
  StubJobQueueAdapter,
  StubPlatformStateAdapter,
  StubPlatformSpanAdapter,
  startJobQueuePolling,
} from '../platform-adapters.js';
import type { JobAssignment, JobQueueAdapter } from '../platform-adapters.js';

describe('StubJobQueueAdapter', () => {
  it('should return empty jobs', async () => {
    const adapter = new StubJobQueueAdapter();
    const jobs = await adapter.pollJobs('w1', ['c1'], 5);
    expect(jobs).toEqual([]);
  });

  it('should return not acknowledged on complete', async () => {
    const adapter = new StubJobQueueAdapter();
    const result = await adapter.completeJob('j1', true, '{}');
    expect(result.acknowledged).toBe(false);
  });
});

describe('StubPlatformStateAdapter', () => {
  it('should return null on load', async () => {
    const adapter = new StubPlatformStateAdapter();
    const data = await adapter.load('scope', 'id');
    expect(data).toBeNull();
  });

  it('should not throw on save', async () => {
    const adapter = new StubPlatformStateAdapter();
    await expect(adapter.save('scope', 'id', { key: 'val' })).resolves.toBeUndefined();
  });
});

describe('StubPlatformSpanAdapter', () => {
  it('should create stub spans', () => {
    const adapter = new StubPlatformSpanAdapter();
    const span = adapter.createSpan('test-op');
    expect(span.traceId).toBe('stub-trace');
    expect(span.spanId).toBe('stub-span');

    // Should not throw
    span.setAttribute('key', 'value');
    span.addEvent('event1');
    span.recordError('error1');
    span.end();
  });
});

describe('startJobQueuePolling', () => {
  it('should poll adapter and process jobs', async () => {
    const job: JobAssignment = {
      jobId: 'j1',
      runId: 'r1',
      componentId: 'c1',
      componentType: 'function',
      componentName: 'greet',
      inputJson: '{"name":"Alice"}',
      metadata: {},
    };

    let pollCount = 0;
    const completedJobs: string[] = [];

    const adapter: JobQueueAdapter = {
      async pollJobs() {
        pollCount++;
        // Return job on first poll, then empty
        if (pollCount === 1) return [job];
        return [];
      },
      async completeJob(jobId, success) {
        completedJobs.push(jobId);
        return { acknowledged: true };
      },
    };

    const controller = startJobQueuePolling({
      workerId: 'w1',
      componentIds: ['c1'],
      concurrency: 5,
      pollIntervalMs: 10,
      maxPollIntervalMs: 100,
      adapter,
      handler: async (j) => ({ outputJson: '{"result":"ok"}' }),
    });

    // Wait for polling to process
    await new Promise(resolve => setTimeout(resolve, 100));
    controller.abort();

    expect(pollCount).toBeGreaterThanOrEqual(1);
    expect(completedJobs).toContain('j1');
  });

  it('should respect concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;

    const jobs: JobAssignment[] = Array.from({ length: 5 }, (_, i) => ({
      jobId: `j${i}`,
      runId: `r${i}`,
      componentId: 'c1',
      componentType: 'function',
      componentName: 'slow',
      inputJson: '{}',
      metadata: {},
    }));

    let pollDone = false;
    const adapter: JobQueueAdapter = {
      async pollJobs(_wid, _cids, maxJobs) {
        if (!pollDone) {
          pollDone = true;
          return jobs.slice(0, maxJobs);
        }
        return [];
      },
      async completeJob() {
        return { acknowledged: true };
      },
    };

    const controller = startJobQueuePolling({
      workerId: 'w1',
      componentIds: ['c1'],
      concurrency: 2,
      pollIntervalMs: 10,
      maxPollIntervalMs: 50,
      adapter,
      handler: async () => {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);
        await new Promise(resolve => setTimeout(resolve, 50));
        activeCount--;
        return { outputJson: '{}' };
      },
    });

    await new Promise(resolve => setTimeout(resolve, 200));
    controller.abort();

    // Should have respected concurrency limit of 2
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
