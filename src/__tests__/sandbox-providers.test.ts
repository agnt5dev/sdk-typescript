/**
 * Unit tests for sandbox provider integrations (wire-format helpers).
 *
 * These mirror the Rust unit tests in sdk-core/src/sandbox/providers/ —
 * the Rust types are canonical and the TS clients conform to them.
 */

import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _internal,
  E2BSandbox,
  E2BSandboxProvider,
  loadProvidersFromEnv,
  NorthflankSandbox,
  NorthflankSandboxProvider,
  SandboxProviderError,
  TogetherSandbox,
  VercelSandboxProvider,
} from '../sandbox-providers.js';

const { interpreterArgv, shellQuote, parseListingOutput, buildTar } = _internal;

describe('shared helpers', () => {
  it('builds interpreter argv per language', () => {
    expect(interpreterArgv('python', 'print(1)')).toEqual(['python3', ['-c', 'print(1)']]);
    expect(interpreterArgv('javascript', 'x')).toEqual(['node', ['-e', 'x']]);
    expect(interpreterArgv('bash', 'echo hi')).toEqual(['bash', ['-c', 'echo hi']]);
    expect(() => interpreterArgv('cobol', 'x')).toThrow(SandboxProviderError);
  });

  it('shell-quotes single quotes safely', () => {
    expect(shellQuote('plain')).toBe("'plain'");
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
  });

  it('parses listing output', () => {
    const stdout =
      'f|42|644|1718200000.5|/workspace/test.txt\n' +
      'd|4096|755|1718200001.0|/workspace/src\n' +
      'bogus line\n';
    const files = parseListingOutput(stdout);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      name: 'test.txt',
      size: 42,
      mode: 0o644,
      isDir: false,
      modTime: 1718200000500,
    });
    expect(files[1]).toMatchObject({ name: 'src', isDir: true });
  });

  it('builds a valid single-file tar archive', () => {
    const content = Buffer.from('hello');
    const tar = buildTar('dir/test.txt', content, 0o644);
    expect(tar.length % 512).toBe(0);
    // Header fields: name, mode, size, ustar magic.
    expect(tar.subarray(0, 12).toString().replace(/\0+$/, '')).toBe('dir/test.txt');
    expect(parseInt(tar.subarray(100, 108).toString(), 8)).toBe(0o644);
    expect(parseInt(tar.subarray(124, 136).toString(), 8)).toBe(5);
    expect(tar.subarray(257, 262).toString()).toBe('ustar');
    // Checksum: sum of header bytes with checksum field as spaces.
    const header = Buffer.from(tar.subarray(0, 512));
    const stored = parseInt(header.subarray(148, 156).toString(), 8);
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    expect(stored).toBe(sum);
    // Content follows the header.
    expect(tar.subarray(512, 517).toString()).toBe('hello');
  });

  it('gzip round-trips the tar archive', () => {
    const { gzipSync } = require('node:zlib');
    const tar = buildTar('a.txt', Buffer.from('x'), 0o600);
    expect(gunzipSync(gzipSync(tar)).equals(tar)).toBe(true);
  });
});

describe('env detection', () => {
  const VARS = [
    'E2B_API_KEY',
    'DAYTONA_API_KEY',
    'VERCEL_OIDC_TOKEN',
    'VERCEL_TOKEN',
    'VERCEL_TEAM_ID',
    'VERCEL_PROJECT_ID',
    'NORTHFLANK_API_TOKEN',
    'NORTHFLANK_PROJECT_ID',
    'TOGETHER_API_KEY',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });
  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  it('returns nothing when unconfigured', () => {
    expect(loadProvidersFromEnv()).toEqual({});
  });

  it('detects configured providers', () => {
    process.env.E2B_API_KEY = 'e2b_test';
    process.env.TOGETHER_API_KEY = 'tok';
    const providers = loadProvidersFromEnv();
    expect(Object.keys(providers).sort()).toEqual(['e2b', 'together']);
  });

  it('throws on partially configured vercel', () => {
    process.env.VERCEL_TOKEN = 'tok';
    expect(() => loadProvidersFromEnv()).toThrow(SandboxProviderError);
  });

  it('throws on northflank without project', () => {
    process.env.NORTHFLANK_API_TOKEN = 'tok';
    expect(() => loadProvidersFromEnv()).toThrow(SandboxProviderError);
  });
});

describe('E2B', () => {
  it('builds data-plane URLs', () => {
    const sandbox = new E2BSandbox('abc123', 'e2b.app');
    expect(sandbox.previewUrl(3000)).toBe('https://3000-abc123.e2b.app');
    expect(sandbox.envdUrl).toBe('https://49983-abc123.e2b.app');
    expect(sandbox.interpreterUrl).toBe('https://49999-abc123.e2b.app');
  });

  it('defaults api url from domain', () => {
    const provider = new E2BSandboxProvider({ apiKey: 'k', domain: 'e2b.dev' });
    expect((provider as any).apiUrl).toBe('https://api.e2b.dev');
  });
});

describe('Northflank', () => {
  const make = (teamId?: string) =>
    new NorthflankSandbox('svc', 'proj', 'tok', teamId, 'https://api.northflank.com', {});

  it('builds the exec websocket URL', () => {
    expect(make().wsUrl()).toBe(
      'wss://api.northflank.com/v1/command-exec/projects/proj/services/svc'
    );
    expect(make('team').wsUrl()).toBe(
      'wss://api.northflank.com/v1/command-exec/teams/team/projects/proj/services/svc'
    );
  });

  it('extracts deployment status', () => {
    expect(NorthflankSandboxProvider.deploymentStatus({ deployment: { status: 'RUNNING' } })).toBe(
      'RUNNING'
    );
    expect(NorthflankSandboxProvider.deploymentStatus({ status: 'PAUSED' })).toBe('PAUSED');
    expect(NorthflankSandboxProvider.deploymentStatus(undefined)).toBe('unknown');
  });
});

describe('Vercel', () => {
  it('exposes preview routes from create response', () => {
    const provider = new VercelSandboxProvider({ token: 't', teamId: 'team', projectId: 'prj' });
    const sandbox = (provider as any).handle({
      sandbox: { name: 'agnt5-x' },
      session: { id: 'sess_1' },
      routes: [{ url: 'https://x.vercel.run', port: 3000 }],
    });
    expect(sandbox.previewUrl(3000)).toBe('https://x.vercel.run');
    expect(sandbox.previewUrl(9999)).toBeUndefined();
    expect(sandbox.sandboxId).toBe('agnt5-x');
  });
});

describe('Together', () => {
  it('maps outputs on success', () => {
    const result = TogetherSandbox.mapOutputs({
      session_id: 'ses_1',
      status: 'success',
      outputs: [
        { type: 'stdout', data: 'hello\n' },
        { type: 'stderr', data: 'warn\n' },
        { type: 'execute_result', data: { 'text/plain': '42' } },
      ],
    });
    expect(result.stdout).toBe('hello\n42');
    expect(result.stderr).toBe('warn\n');
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it('maps error outputs to exit code 1', () => {
    const result = TogetherSandbox.mapOutputs({
      status: 'error',
      outputs: [{ type: 'error', data: 'NameError: x' }],
    });
    expect(result.exitCode).toBe(1);
    expect(result.error).toBe('NameError: x');
  });
});
