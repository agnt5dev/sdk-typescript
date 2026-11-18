// A chat run's bot token is fetched with the worker's workload identity: the
// run's input names the integration and carries no token, because run input
// is stored with the run's history.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BotTokenSource } from '../chat-credentials.js';

interface Call {
  path: string;
  body: Record<string, unknown>;
  authorization: string | null;
}

function broker(calls: Call[], status = 200): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const headers = new Headers(init?.headers);
    calls.push({ path, body, authorization: headers.get('authorization') });
    if (path === '/internal/workload/token') {
      return new Response(JSON.stringify({ token: 'workload-token' }), { status: 200 });
    }
    if (status !== 200) {
      return new Response(JSON.stringify({ error: 'integration not found' }), { status });
    }
    return new Response(
      JSON.stringify({ value: 'xoxb-fetched', expires_at: '2999-01-01T00:00:00Z', integration_id: body.ref }),
      { status: 200 },
    );
  }) as typeof fetch;
}

function tokenFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'agnt5-identity-')), 'token');
  writeFileSync(path, 'projected-token\n');
  return path;
}

describe('BotTokenSource', () => {
  it('fetches the token once for its integration', async () => {
    const calls: Call[] = [];
    const source = new BotTokenSource({ brokerUrl: 'http://broker', tokenFile: tokenFile(), fetch: broker(calls) });

    expect(await source.get('integration-1')).toBe('xoxb-fetched');
    expect(await source.get('integration-1')).toBe('xoxb-fetched');

    expect(calls.map((call) => call.path)).toEqual(['/internal/workload/token', '/internal/workload/credential']);
    expect(calls[0].body).toEqual({ token: 'projected-token', audience: ['agnt5-credentials'] });
    expect(calls[1].body).toEqual({ scope: 'chat_bot_token', ref: 'integration-1', purpose: 'chat_reply' });
    expect(calls[1].authorization).toBe('Bearer workload-token');
  });

  it('falls back when the fetch is refused', async () => {
    const calls: Call[] = [];
    const logged: string[] = [];
    const source = new BotTokenSource({
      brokerUrl: 'http://broker',
      tokenFile: tokenFile(),
      fetch: broker(calls, 404),
      logger: (message) => logged.push(message),
    });

    expect(await source.get('integration-1')).toBeUndefined();
    expect(logged.join('\n')).toContain('integration not found');
  });

  it('fetches nothing without a workload identity', async () => {
    const calls: Call[] = [];
    const file = tokenFile();
    expect(await new BotTokenSource({ brokerUrl: '', tokenFile: file, fetch: broker(calls) }).get('integration-1')).toBeUndefined();
    expect(await new BotTokenSource({ brokerUrl: 'http://broker', tokenFile: '', fetch: broker(calls) }).get('integration-1')).toBeUndefined();
    expect(await new BotTokenSource({ brokerUrl: 'http://broker', tokenFile: file, fetch: broker(calls) }).get(undefined)).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
