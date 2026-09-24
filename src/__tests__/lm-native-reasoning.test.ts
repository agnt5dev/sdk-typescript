import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LM } from '../lm.js';
import { tryLoadNativeBindings } from '#native-loader';

// The native path: LM hands the request to agnt5-sdk-core, whose own
// reasoning-model predicate decides the payload. The edge tests mock the
// bindings away, so they cannot catch a core that predates gpt-6 (AGNT5-1302).
// Needs the built binary (`npm run build:napi`); skipped when it is absent.
const native = tryLoadNativeBindings();

describe.skipIf(!native)('native OpenAI reasoning-model payloads', () => {
  let server: Server;
  let endpoint: string;
  const bodies: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chat_native', object: 'chat.completion', model: 'gpt-6-luna', created: 1,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sends gpt-6 no sampling parameters and max_completion_tokens through the native Azure provider', async () => {
    bodies.length = 0;
    const lm = LM.azure({ apiKey: 'native-key', endpoint });
    await lm.generate({
      model: 'azure/gpt-6-luna',
      messages: [{ role: 'user', content: 'Say hello.' }],
      config: { temperature: 0.7, topP: 0.9, maxOutputTokens: 64 },
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].temperature).toBeUndefined();
    expect(bodies[0].top_p).toBeUndefined();
    expect(bodies[0].max_tokens).toBeUndefined();
    expect(bodies[0].max_completion_tokens).toBe(64);
  });

  it('keeps the classic parameters for gpt-4.1 on the native Azure provider', async () => {
    bodies.length = 0;
    const lm = LM.azure({ apiKey: 'native-key', endpoint });
    await lm.generate({
      model: 'azure/gpt-4.1-mini',
      messages: [{ role: 'user', content: 'Say hello.' }],
      config: { temperature: 0.7, topP: 0.9, maxOutputTokens: 64 },
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].temperature).toBe(0.7);
    expect(bodies[0].top_p).toBe(0.9);
    expect(bodies[0].max_tokens).toBe(64);
    expect(bodies[0].max_completion_tokens).toBeUndefined();
  });
});
