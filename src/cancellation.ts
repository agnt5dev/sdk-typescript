/** Combine caller and runtime cancellation, with listener cleanup. */
export function combineSignals(...signals: Array<AbortSignal | undefined>): { signal?: AbortSignal; dispose(): void } {
  const sources = [...new Set(signals.filter((signal): signal is AbortSignal => !!signal))];
  if (sources.length < 2) return { signal: sources[0], dispose() {} };
  const controller = new AbortController();
  const listeners = sources.map(signal => {
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    return () => signal.removeEventListener('abort', abort);
  });
  return { signal: controller.signal, dispose() { for (const remove of listeners) remove(); } };
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Operation aborted', 'AbortError');
}

/** Stop waiting immediately; the operation receives the same signal to stop its I/O. */
export async function abortable<T>(operation: () => T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return await operation();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new DOMException('Operation aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => { throwIfAborted(signal); return operation(); }), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}
