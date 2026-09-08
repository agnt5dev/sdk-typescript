import { getLoadedNativeBindings } from './native-loader.js';

/** Measure business work with the same monotonic clock as pull-slot events. */
export async function measureBusiness<T>(runId: string, execute: () => T | Promise<T>): Promise<T> {
  const native = getLoadedNativeBindings();
  let started: number | undefined;
  try {
    started = native?.coreMetricTimeMs?.();
  } catch {
    // Telemetry must not change the execution result.
  }
  let outcome = 'success';
  try {
    return await execute();
  } catch (error) {
    outcome = error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'error';
    throw error;
  } finally {
    if (started !== undefined) {
      try {
        native?.recordCoreBusinessTiming?.(runId, started, outcome);
      } catch {
        // Older bindings and failed telemetry leave the measurement unavailable.
      }
    }
  }
}
