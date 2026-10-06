import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { LM } from '../lm.js';
import { createEdgeLanguageModel } from '../providers/edge.js';
import { tryLoadNativeBindings } from '#native-loader';
const native = tryLoadNativeBindings();

describe('provider cancellation', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  async function fixture(stream: boolean) {
    let requested!: () => void;
    let disconnected!: () => void;
    const request = new Promise<void>(resolve => { requested = resolve; });
    const disconnect = new Promise<void>(resolve => { disconnected = resolve; });
    const responses = new Set<ServerResponse>();
    const server = createServer((req, response) => {
      responses.add(response);
      response.on('close', () => { responses.delete(response); disconnected(); });
      req.resume();
      req.on('end', () => {
        if (stream) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
        }
        requested();
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    close = async () => { for (const response of responses) response.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
    return { request, disconnect, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  for (const surface of ['edge', 'native'] as const) {
    for (const streaming of [false, true]) {
      it.skipIf(surface === 'native' && !native)(`${surface} ${streaming ? 'stream' : 'generate'} abort closes HTTP I/O`, async () => {
        const { endpoint, request, disconnect } = await fixture(streaming);
        const model = surface === 'native'
          ? LM.openaiChat({ apiKey: 'test', baseUrl: endpoint })
          : createEdgeLanguageModel('openai_chat', { apiKey: 'test', baseUrl: endpoint });
        const controller = new AbortController();
        const input = { model: 'openai_chat/test', messages: [{ role: 'user', content: 'go' }], signal: controller.signal };
        const events: string[] = [];
        const running = streaming ? model.stream(input, event => events.push(event.chunkType)) : model.generate(input);
        // Attach a rejection handler before aborting to keep the test isolated.
        const rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' });
        await request;
        controller.abort();
        await rejected;
        await Promise.race([disconnect, new Promise((_, reject) => setTimeout(() => reject(new Error('HTTP connection remained open')), 1000))]);
        expect(events).not.toContain('completed');
      });
    }
  }
});
