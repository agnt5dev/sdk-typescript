import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Client, RunResponse } from '../client';

// ---------------------------------------------------------------------------
// RunResponse unit tests
// ---------------------------------------------------------------------------

describe('RunResponse', () => {
  it('should parse a successful response', () => {
    const resp = new RunResponse({
      run_id: 'run-1',
      status: 'completed',
      output: { greeting: 'Hello' },
      duration_ms: 42,
      trace_id: 'trace-abc',
      status_code: 200,
    });

    expect(resp.runId).toBe('run-1');
    expect(resp.status).toBe('completed');
    expect(resp.output).toEqual({ greeting: 'Hello' });
    expect(resp.durationMs).toBe(42);
    expect(resp.traceId).toBe('trace-abc');
    expect(resp.isSuccess).toBe(true);
    expect(resp.isPending).toBe(false);
    expect(resp.isError).toBe(false);
    expect(resp.elapsed).toBe(42);
  });

  it('should parse a failed response with string error', () => {
    const resp = new RunResponse({
      run_id: 'run-2',
      status: 'failed',
      error: 'Something went wrong',
      status_code: 500,
    });

    expect(resp.isSuccess).toBe(false);
    expect(resp.isError).toBe(true);
    expect(resp.error?.message).toBe('Something went wrong');
    expect(resp.error?.code).toBe('EXECUTION_FAILED');
  });

  it('should parse a failed response with structured error', () => {
    const resp = new RunResponse({
      run_id: 'run-3',
      status: 'failed',
      error: { code: 'TIMEOUT', message: 'Function timed out after 30s' },
    });

    expect(resp.isError).toBe(true);
    expect(resp.error?.code).toBe('TIMEOUT');
    expect(resp.error?.message).toBe('Function timed out after 30s');
  });

  it('should detect pending status', () => {
    for (const status of ['enqueued', 'started', 'running', 'paused', 'awaiting_input'] as const) {
      const resp = new RunResponse({ run_id: 'run-x', status, status_code: 202 });
      expect(resp.isPending).toBe(true);
      expect(resp.isSuccess).toBe(false);
    }
  });

  it('should infer statusCode from status when not provided', () => {
    const completed = new RunResponse({ run_id: 'r1', status: 'completed' });
    expect(completed.statusCode).toBe(200);

    const failed = new RunResponse({ run_id: 'r2', status: 'failed' });
    expect(failed.statusCode).toBe(500);

    const running = new RunResponse({ run_id: 'r3', status: 'running' });
    expect(running.statusCode).toBe(202);
  });

  it('raiseForStatus should throw on error', () => {
    const resp = new RunResponse({
      run_id: 'run-err',
      status: 'failed',
      error: 'boom',
    });

    expect(() => resp.raiseForStatus()).toThrow('boom');
  });

  it('raiseForStatus should not throw on success', () => {
    const resp = new RunResponse({
      run_id: 'run-ok',
      status: 'completed',
      output: 42,
    });

    expect(() => resp.raiseForStatus()).not.toThrow();
  });

  it('should handle runId in either field', () => {
    const resp1 = new RunResponse({ run_id: 'a' });
    expect(resp1.runId).toBe('a');

    const resp2 = new RunResponse({ runId: 'b' });
    expect(resp2.runId).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// Client construction tests
// ---------------------------------------------------------------------------

describe('Client', () => {
  it('should create with defaults', () => {
    const client = new Client();
    expect(client).toBeDefined();
  });

  it('should accept custom gateway URL', () => {
    const client = new Client({ gatewayUrl: 'https://api.example.com' });
    expect(client).toBeDefined();
  });

  it('should accept API key', () => {
    const client = new Client({ apiKey: 'agnt5_sk_test123' });
    expect(client).toBeDefined();
  });

  it('should strip trailing slash from gateway URL', () => {
    const client = new Client({ gatewayUrl: 'http://localhost:34181/' });
    // Access private field for testing
    expect((client as any).gatewayUrl).toBe('http://localhost:34181');
  });

  it('should include API key in headers', () => {
    const client = new Client({ apiKey: 'agnt5_sk_test' });
    const headers = (client as any).buildHeaders();
    expect(headers['X-API-KEY']).toBe('agnt5_sk_test');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('should not include API key header when no key provided', () => {
    const client = new Client();
    const headers = (client as any).buildHeaders();
    expect(headers['X-API-KEY']).toBeUndefined();
  });

  it('should merge extra headers', () => {
    const client = new Client({ apiKey: 'agnt5_sk_test' });
    const headers = (client as any).buildHeaders({
      'X-Session-ID': 'sess-1',
      'X-User-ID': 'user-1',
    });
    expect(headers['X-API-KEY']).toBe('agnt5_sk_test');
    expect(headers['X-Session-ID']).toBe('sess-1');
    expect(headers['X-User-ID']).toBe('user-1');
  });

  it('should read API key from environment', () => {
    const origEnv = process.env.AGNT5_API_KEY;
    try {
      process.env.AGNT5_API_KEY = 'agnt5_sk_from_env';
      const client = new Client();
      expect((client as any).apiKey).toBe('agnt5_sk_from_env');
    } finally {
      if (origEnv !== undefined) {
        process.env.AGNT5_API_KEY = origEnv;
      } else {
        delete process.env.AGNT5_API_KEY;
      }
    }
  });

  it('should prefer explicit API key over env', () => {
    const origEnv = process.env.AGNT5_API_KEY;
    try {
      process.env.AGNT5_API_KEY = 'agnt5_sk_from_env';
      const client = new Client({ apiKey: 'agnt5_sk_explicit' });
      expect((client as any).apiKey).toBe('agnt5_sk_explicit');
    } finally {
      if (origEnv !== undefined) {
        process.env.AGNT5_API_KEY = origEnv;
      } else {
        delete process.env.AGNT5_API_KEY;
      }
    }
  });
});
