import { describe, expect, it, vi } from 'vitest';
import { measureBusiness } from '../core-metrics.js';
import { getLoadedNativeBindings } from '../native-loader.js';

vi.mock('../native-loader.js', () => ({ getLoadedNativeBindings: vi.fn() }));

describe('business execution timing', () => {
  it('measures the actual body and preserves the original failure', async () => {
    const record = vi.fn();
    vi.mocked(getLoadedNativeBindings).mockReturnValue({
      coreMetricTimeMs: () => 100, recordCoreBusinessTiming: record,
    });
    const failure = new Error('user failure');
    await expect(measureBusiness('run', () => { throw failure; })).rejects.toBe(failure);
    expect(record).toHaveBeenCalledWith('run', 100, 'error');
  });

  it('does not let telemetry failure change a successful result', async () => {
    vi.mocked(getLoadedNativeBindings).mockReturnValue({
      coreMetricTimeMs: () => 100,
      recordCoreBusinessTiming: () => { throw new Error('telemetry unavailable'); },
    });
    expect(await measureBusiness('run', async () => 42)).toBe(42);
  });
});
