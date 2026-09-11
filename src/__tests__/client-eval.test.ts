import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '../client.js';

afterEach(() => vi.unstubAllGlobals());

describe('managed evaluation', () => {
  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid batch concurrency %s', async (maxConcurrency) => {
    vi.stubGlobal('fetch', vi.fn());
    const client = new Client();
    await expect(client.batchEval('greet', [{ input: { name: 'Alice' } }], {
      maxConcurrency,
    })).rejects.toThrow('maxConcurrency must be a positive integer');
  }, 100);

  it('calls the managed eval route and preserves scorer failures separately from execution errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      run_id: 'eval-run', status: 'completed', output: 'Hello', passed: false,
      scores: [{ scorer: 'exact_match', score: 0, passed: false }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new Client({ gatewayUrl: 'http://localhost:34181', apiKey: 'test-key' });
    const result = await client.eval('greet', { name: 'Alice' }, { expected: 'Goodbye' });
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:34181/v1/eval');
    expect(JSON.parse(request.body)).toMatchObject({
      component: 'greet', component_type: 'function', input: { name: 'Alice' },
      expected: 'Goodbye', scorers: [{ name: 'exact_match' }],
    });
    expect(result.isSuccess).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.getScore('exact_match')?.score).toBe(0);
  });
});
