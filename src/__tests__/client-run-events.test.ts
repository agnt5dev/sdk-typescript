import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '../client.js';
import { RunError } from '../errors.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function client() {
  return new Client({ gatewayUrl: 'https://gateway.test', apiKey: 'sk-test', tenantId: 'acme' });
}

function frame(eventType: string, offset: number, id: string = String(offset), data: unknown = {}) {
  const record = { event_type: eventType, run_id: 'run-1', offset, data, metadata: {} };
  return `event: ${eventType}\nid: ${id}\ndata: ${JSON.stringify(record)}\n\n`;
}

/** An SSE body that sends `frames`, then stays open unless `close`. */
function sseResponse(frames: string[], close = false): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const text of frames) controller.enqueue(encoder.encode(text));
      controller.enqueue(encoder.encode(': keepalive\n\n'));
      if (close) controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function collect(events: AsyncGenerator<{ eventType: string; offset?: number; data: any }>) {
  const seen = [];
  for await (const event of events) seen.push(event);
  return seen;
}

describe('Client.signal', () => {
  it('posts the payload to the run and returns the receipt', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      run_id: 'run-1', signal_id: 'sig-1', signal_name: 'page_read', offset: 12, resumed: true, resume_offset: 13,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const receipt = await client().signal('run-1', 'page_read', { url: 'https://example.com' });

    expect(receipt).toEqual({
      runId: 'run-1', signalId: 'sig-1', signalName: 'page_read', offset: 12, resumed: true, resumeOffset: 13,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gateway.test/v1/runs/run-1/signals/page_read');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ payload: { url: 'https://example.com' } });
    expect((init.headers as Record<string, string>)['X-Tenant-ID']).toBe('acme');
  });

  it('raises the gateway refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('run not found', { status: 404 })));
    await expect(client().signal('run-x', 'page_read')).rejects.toBeInstanceOf(RunError);
  });
});

describe('Client.followEvents', () => {
  it('yields the run events and ends at the final one, even if the stream stays open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      frame('run.queued', 0),
      frame('crm.progress', 1, '1', { done: 500, total: 1000 }),
      frame('run.completed', 2, 'done'),
    ])));

    const events = await collect(client().followEvents('run-1'));

    expect(events.map((event) => event.eventType)).toEqual(['run.queued', 'crm.progress', 'run.completed']);
    expect(events[1].data).toEqual({ done: 500, total: 1000 });
  });

  it('does not end at a failed attempt that will be retried', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      frame('run.failed', 1),
      frame('run.completed', 2, 'done'),
    ])));

    const events = await collect(client().followEvents('run-1'));

    expect(events.map((event) => event.eventType)).toEqual(['run.failed', 'run.completed']);
  });

  it('reconnects after a dropped connection from the last offset it yielded', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse([frame('run.queued', 0), frame('workflow.step.completed', 1)], true))
      .mockResolvedValueOnce(sseResponse([frame('run.completed', 2, 'done')]));
    vi.stubGlobal('fetch', fetchMock);

    const events = await collect(client().followEvents('run-1', { afterOffset: undefined }));

    expect(events.map((event) => event.eventType)).toEqual(['run.queued', 'workflow.step.completed', 'run.completed']);
    const resumed = fetchMock.mock.calls[1][1] as RequestInit;
    expect((resumed.headers as Record<string, string>)['Last-Event-ID']).toBe('1');
    expect((resumed.headers as Record<string, string>).Accept).toBe('text/event-stream');
  });

  it('does not reconnect when the gateway refuses the run', async () => {
    const fetchMock = vi.fn(async () => new Response('run not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(collect(client().followEvents('run-x'))).rejects.toBeInstanceOf(RunError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up when the stream keeps ending without the run finishing', async () => {
    const fetchMock = vi.fn(async () => sseResponse([], true));
    vi.stubGlobal('fetch', fetchMock);

    await expect(collect(client().followEvents('run-1', { maxReconnects: 1 }))).rejects.toThrow('ended before the run finished');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('closes the stream when the caller stops early', async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame('run.queued', 1) + frame('workflow.started', 2)));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));

    for await (const event of client().followEvents('run-1')) {
      expect(event.eventType).toBe('run.queued');
      break;
    }

    expect(cancelled).toBe(true);
  });
});
