import { readFileSync } from 'node:fs';
import { tryLoadNativeBindings } from './native-loader.js';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function envTruthy(name: string): boolean {
  return TRUTHY.has((process.env[name] ?? '').trim().toLowerCase());
}

export function workerMemoryMetricsEnabled(): boolean {
  return envTruthy('AGNT5_WORKER_MEMORY_METRICS') || envTruthy('AGNT5_WORKER_MEMORY_LOG');
}

export function workerMemoryLoggingEnabled(): boolean {
  return workerMemoryMetricsEnabled();
}

function readInt(path: string): number | undefined {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw || raw === 'max') return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function captureWorkerMemory(): Record<string, number> | undefined {
  if (!workerMemoryMetricsEnabled()) return undefined;

  if (envTruthy('AGNT5_WORKER_MEMORY_GC')) {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (typeof gc === 'function') {
      try {
        gc();
      } catch {
        // Best effort only. Node requires --expose-gc.
      }
    }
  }

  const usage = process.memoryUsage();
  const cgroupCurrent =
    readInt('/sys/fs/cgroup/memory.current') ??
    readInt('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  const cgroupLimit =
    readInt('/sys/fs/cgroup/memory.max') ??
    readInt('/sys/fs/cgroup/memory/memory.limit_in_bytes');

  const snapshot: Record<string, number> = {
    rss_bytes: usage.rss,
    heap_total_bytes: usage.heapTotal,
    heap_used_bytes: usage.heapUsed,
    external_bytes: usage.external,
    array_buffers_bytes: usage.arrayBuffers,
  };
  if (cgroupCurrent !== undefined) snapshot.cgroup_current_bytes = cgroupCurrent;
  if (cgroupLimit !== undefined) snapshot.cgroup_limit_bytes = cgroupLimit;
  return snapshot;
}

export function recordWorkerMemory(input: {
  phase: 'before' | 'after';
  componentType: string;
  componentName: string;
}): void {
  const snapshot = captureWorkerMemory();
  if (!snapshot) return;

  const recordMetric = tryLoadNativeBindings()?.recordWorkerMemoryMetric;
  if (typeof recordMetric !== 'function') return;

  for (const [kind, value] of Object.entries(snapshot)) {
    if (!Number.isFinite(value) || value < 0) continue;
    try {
      recordMetric(
        'typescript',
        input.phase,
        input.componentName,
        input.componentType,
        kind,
        value,
      );
    } catch {
      return;
    }
  }
}
