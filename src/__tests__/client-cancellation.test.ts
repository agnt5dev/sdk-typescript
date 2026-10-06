import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '../client.js';

const requests = [
  ['run', (client: Client, signal: AbortSignal) => client.run('work', {}, { signal, timeoutMs: 20 })],
  ['submit', (client: Client, signal: AbortSignal) => client.submit('work', {}, { signal })],
  ['status', (client: Client, signal: AbortSignal) => client.getStatus('run', signal)],
  ['result', (client: Client, signal: AbortSignal) => client.getResult('run', signal)],
] as const;

function stalledFetch() {
  const fetch = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal!;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('client request cancellation', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it.each(requests)('cancels an in-flight %s request', async (_name, invoke) => {
    const fetch = stalledFetch();
    const controller = new AbortController();
    const error = new Error('caller cancelled');
    const pending = invoke(new Client(), controller.signal);
    const verdict = expect(pending).rejects.toBe(error);
    await Promise.resolve();
    controller.abort(error);
    await verdict;
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(requests)('keeps the %s deadline with a caller signal', async (_name, invoke) => {
    stalledFetch();
    const controller = new AbortController();
    await expect(invoke(new Client({ timeout: 20 }), controller.signal)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(controller.signal.aborted).toBe(false);
  });

  it.each(requests)('keeps cancellation active while reading the %s response body', async (_name, invoke) => {
    const controller = new AbortController();
    const error = new Error('cancel response body');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) }));
    const pending = invoke(new Client(), controller.signal);
    const verdict = expect(pending).rejects.toBe(error);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort(error);
    await verdict;
  });

  it('removes caller listeners after a completed request', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"run_id":"run","status":"completed"}')));
    await new Client().run('work', {}, { signal: controller.signal });
    expect(add).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
  });

  it('does not issue a request for a cancelled run', async () => {
    const fetch = stalledFetch();
    const error = new Error('already cancelled');
    await expect(new Client({ maxRetries: 3 }).run('work', {}, { signal: AbortSignal.abort(error) })).rejects.toBe(error);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels retry backoff without another request or a remaining timer', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockRejectedValue(new TypeError('network failure'));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const error = new Error('cancel retry');
    const pending = new Client({ maxRetries: 3, retryDelayMs: 1000 }).run('work', {}, { signal: controller.signal });
    const verdict = expect(pending).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(error);
    await verdict;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
