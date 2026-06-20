import { afterEach, describe, expect, it } from 'vitest';
import { captureWorkerMemory, workerMemoryMetricsEnabled } from '../worker-memory';

const originalMetricsEnv = process.env.AGNT5_WORKER_MEMORY_METRICS;
const originalEnv = process.env.AGNT5_WORKER_MEMORY_LOG;

afterEach(() => {
  if (originalMetricsEnv === undefined) {
    delete process.env.AGNT5_WORKER_MEMORY_METRICS;
  } else {
    process.env.AGNT5_WORKER_MEMORY_METRICS = originalMetricsEnv;
  }
  if (originalEnv === undefined) {
    delete process.env.AGNT5_WORKER_MEMORY_LOG;
  } else {
    process.env.AGNT5_WORKER_MEMORY_LOG = originalEnv;
  }
});

describe('worker memory snapshots', () => {
  it('is disabled by default', () => {
    delete process.env.AGNT5_WORKER_MEMORY_METRICS;
    delete process.env.AGNT5_WORKER_MEMORY_LOG;

    expect(workerMemoryMetricsEnabled()).toBe(false);
    expect(captureWorkerMemory()).toBeUndefined();
  });

  it('captures process memory when enabled', () => {
    process.env.AGNT5_WORKER_MEMORY_METRICS = '1';

    const snapshot = captureWorkerMemory();

    expect(snapshot).toBeDefined();
    expect(snapshot!.rss_bytes).toBeGreaterThan(0);
    expect(snapshot!.heap_used_bytes).toBeGreaterThan(0);
  });

  it('keeps the old log env as a metrics alias', () => {
    delete process.env.AGNT5_WORKER_MEMORY_METRICS;
    process.env.AGNT5_WORKER_MEMORY_LOG = '1';

    expect(workerMemoryMetricsEnabled()).toBe(true);
  });
});
