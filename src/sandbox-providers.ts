/**
 * Managed sandbox provider integrations.
 *
 * Native fetch-based clients for external sandbox vendors, conforming to
 * the canonical Rust contract in `sdk-core/src/sandbox/providers/`:
 *
 * - {@link E2BSandboxProvider} — E2B (api.e2b.app + envd/code-interpreter)
 * - {@link DaytonaSandboxProvider} — Daytona (app.daytona.io + toolbox proxy)
 * - {@link VercelSandboxProvider} — Vercel Sandbox (api.vercel.com /v2/sandboxes)
 * - {@link NorthflankSandboxProvider} — Northflank (REST + websocket exec; needs Node >= 22 for the global WebSocket)
 * - {@link TogetherSandboxProvider} — Together Code Interpreter (/v1/tci)
 *
 * Modal is not included here: its API is gRPC-only and is integrated
 * natively in the Rust core (sdk-core); a TS surface for it would need
 * gRPC bindings rather than fetch.
 *
 * Provider sandboxes expose the same data-plane surface as {@link Sandbox}
 * (executeCode, runCommand, writeFile, readFile, deleteFile, listFiles,
 * health) plus provider extras (preview URLs, Daytona git operations).
 *
 * @example
 * ```ts
 * import { E2BSandboxProvider } from '@agnt5/sdk';
 *
 * const provider = E2BSandboxProvider.fromEnv();
 * const sandbox = await provider.create({ timeoutSecs: 300 });
 * const result = await sandbox.executeCode('print(6 * 7)', 'python');
 * console.log(result.stdout); // "42"
 * await provider.destroy(sandbox.sandboxId);
 * ```
 */

import { gzipSync } from 'node:zlib';
import type {
  ExecuteCodeResult,
  FileInfo,
  HealthResult,
  ListFilesResult,
  ReadFileResult,
  WriteFileResult,
} from './sandbox.js';

// ── Shared types ───────────────────────────────────────────────

/** Provider-agnostic sandbox creation options. Providers ignore options they don't support. */
export interface CreateSandboxOptions {
  /** Template, snapshot, or container image identifier (provider-specific). */
  template?: string;
  /** Sandbox lifetime in seconds before the provider auto-stops it. */
  timeoutSecs?: number;
  /** Environment variables available inside the sandbox. */
  env?: Record<string, string>;
  /** Arbitrary metadata/labels attached to the sandbox. */
  metadata?: Record<string, string>;
  /** CPU cores to allocate. */
  cpuCores?: number;
  /** Memory in MiB to allocate. */
  memoryMib?: number;
}

/** Summary info about a provider sandbox instance. */
export interface SandboxInfo {
  sandboxId: string;
  status: string;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTimeMs: number;
  error?: string;
}

export interface RunCommandOptions {
  args?: string[];
  workingDir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Error from a sandbox provider API. */
export class SandboxProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly operation: string,
    message: string
  ) {
    super(`${provider} ${operation}: ${message}`);
    this.name = 'SandboxProviderError';
  }
}

// ── Shared helpers ─────────────────────────────────────────────

const INTERPRETERS: Record<string, [string, string]> = {
  python: ['python3', '-c'],
  javascript: ['node', '-e'],
  bash: ['bash', '-c'],
};

function interpreterArgv(language: string, code: string): [string, string[]] {
  const entry = INTERPRETERS[language];
  if (!entry) {
    throw new SandboxProviderError('sandbox', 'executeCode', `unsupported language: ${language}`);
  }
  return [entry[0], [entry[1], code]];
}

/** Quote a string for safe interpolation into a POSIX shell command line. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Parse `type|size|mode|mtime|path` directory-listing lines (the output of
 * GNU `find -printf '%y|%s|%m|%T@|%p\n'`).
 */
function parseListingOutput(stdout: string): FileInfo[] {
  const files: FileInfo[] = [];
  for (const line of stdout.split('\n')) {
    const parts = line.split('|');
    if (parts.length < 5) continue;
    const path = parts.slice(4).join('|');
    files.push({
      name: path.split('/').pop() ?? path,
      path,
      size: Number(parts[1]) || 0,
      mode: parseInt(parts[2], 8) || 0,
      isDir: parts[0] === 'd',
      modTime: Math.round((Number(parts[3]) || 0) * 1000),
    });
  }
  return files;
}

async function check(provider: string, operation: string, resp: Response): Promise<Response> {
  if (!resp.ok) {
    const body = (await resp.text().catch(() => '')).slice(0, 500);
    throw new SandboxProviderError(provider, operation, `HTTP ${resp.status} — ${body}`);
  }
  return resp;
}

function requireEnv(provider: string, name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new SandboxProviderError(provider, 'fromEnv', `${name} is required`);
  }
  return value;
}

// ── E2B ────────────────────────────────────────────────────────

export interface E2BProviderOptions {
  apiKey: string;
  /** Sandbox routing domain. Default: `e2b.app`. */
  domain?: string;
  apiUrl?: string;
  /** Template for new sandboxes. Default: `code-interpreter-v1`. */
  template?: string;
}

/**
 * Control plane for E2B sandboxes (https://e2b.dev).
 *
 * Code/command execution uses the code-interpreter data plane (port 49999),
 * so the default template is `code-interpreter-v1`. File operations use
 * envd (port 49983) and work on any template.
 */
export class E2BSandboxProvider {
  readonly name = 'e2b';
  private readonly apiKey: string;
  private readonly domain: string;
  private readonly apiUrl: string;
  private readonly template: string;

  constructor(options: E2BProviderOptions) {
    this.apiKey = options.apiKey;
    this.domain = options.domain ?? 'e2b.app';
    this.apiUrl = options.apiUrl ?? `https://api.${this.domain}`;
    this.template = options.template ?? 'code-interpreter-v1';
  }

  /** Build from E2B_API_KEY (+ optional E2B_DOMAIN, E2B_API_URL, E2B_TEMPLATE). */
  static fromEnv(): E2BSandboxProvider {
    return new E2BSandboxProvider({
      apiKey: requireEnv('e2b', 'E2B_API_KEY'),
      domain: process.env.E2B_DOMAIN,
      apiUrl: process.env.E2B_API_URL,
      template: process.env.E2B_TEMPLATE,
    });
  }

  private headers(): Record<string, string> {
    return { 'X-API-Key': this.apiKey, 'Content-Type': 'application/json' };
  }

  private handle(data: { sandboxID: string; envdAccessToken?: string; domain?: string }): E2BSandbox {
    return new E2BSandbox(data.sandboxID, data.domain ?? this.domain, data.envdAccessToken);
  }

  async create(opts: CreateSandboxOptions = {}): Promise<E2BSandbox> {
    const body: Record<string, unknown> = {
      templateID: opts.template ?? this.template,
      timeout: opts.timeoutSecs ?? 300,
    };
    if (opts.env) body.envVars = opts.env;
    if (opts.metadata) body.metadata = opts.metadata;
    const resp = await check(
      'e2b',
      'create',
      await fetch(`${this.apiUrl}/sandboxes`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      })
    );
    return this.handle(
      (await resp.json()) as { sandboxID: string; envdAccessToken?: string; domain?: string }
    );
  }

  /** Connect to an existing sandbox, resuming it if paused. */
  async connect(sandboxId: string): Promise<E2BSandbox> {
    const resp = await check(
      'e2b',
      'connect',
      await fetch(`${this.apiUrl}/sandboxes/${sandboxId}/connect`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ timeout: 300 }),
      })
    );
    return this.handle(
      (await resp.json()) as { sandboxID: string; envdAccessToken?: string; domain?: string }
    );
  }

  async destroy(sandboxId: string): Promise<boolean> {
    await check(
      'e2b',
      'destroy',
      await fetch(`${this.apiUrl}/sandboxes/${sandboxId}`, {
        method: 'DELETE',
        headers: this.headers(),
      })
    );
    return true;
  }

  async listSandboxes(): Promise<SandboxInfo[]> {
    const resp = await check(
      'e2b',
      'listSandboxes',
      await fetch(`${this.apiUrl}/sandboxes`, { headers: this.headers() })
    );
    const items = (await resp.json()) as Array<{ sandboxID?: string; state?: string }>;
    return items.map((item) => ({
      sandboxId: item.sandboxID ?? '',
      status: item.state ?? 'running',
    }));
  }

  /** Extend the sandbox lifetime to `timeoutSecs` from now. */
  async setTimeout(sandboxId: string, timeoutSecs: number): Promise<void> {
    await check(
      'e2b',
      'setTimeout',
      await fetch(`${this.apiUrl}/sandboxes/${sandboxId}/timeout`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ timeout: timeoutSecs }),
      })
    );
  }
}

/** A running E2B sandbox. */
export class E2BSandbox {
  readonly languages = ['python', 'javascript', 'bash'];
  readonly envdUrl: string;
  readonly interpreterUrl: string;

  constructor(
    public readonly sandboxId: string,
    public readonly domain: string = 'e2b.app',
    private readonly envdAccessToken?: string
  ) {
    this.envdUrl = `https://49983-${sandboxId}.${domain}`;
    this.interpreterUrl = `https://49999-${sandboxId}.${domain}`;
  }

  /** Public URL for a port inside the sandbox (no API call required). */
  previewUrl(port: number): string {
    return `https://${port}-${this.sandboxId}.${this.domain}`;
  }

  private envdHeaders(extra: Record<string, string> = {}): Record<string, string> {
    // envd selects the OS user via Basic auth with an empty password.
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from('user:').toString('base64')}`,
      ...extra,
    };
    if (this.envdAccessToken) headers['X-Access-Token'] = this.envdAccessToken;
    return headers;
  }

  private async executeRaw(
    code: string,
    language: string,
    env: Record<string, string> | undefined,
    timeoutMs: number
  ): Promise<{ stdout: string; stderr: string; error?: string; elapsedMs: number }> {
    const body: Record<string, unknown> = { code, language };
    if (env) body.env_vars = env;
    const started = Date.now();
    const resp = await check(
      'e2b',
      'executeCode',
      await fetch(`${this.interpreterUrl}/execute`, {
        method: 'POST',
        headers: this.envdHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs + 30_000),
      })
    );
    let stdout = '';
    let stderr = '';
    let error: string | undefined;
    for (const line of (await resp.text()).split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: any;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (event.type === 'stdout') stdout += event.text ?? '';
      else if (event.type === 'stderr') stderr += event.text ?? '';
      else if (event.type === 'error') error = `${event.name ?? 'Error'}: ${event.value ?? ''}`;
    }
    return { stdout, stderr, error, elapsedMs: Date.now() - started };
  }

  async executeCode(
    code: string,
    language: string = 'python',
    options: { timeoutMs?: number; env?: Record<string, string>; workDir?: string } = {}
  ): Promise<ExecuteCodeResult> {
    let effective = code;
    if (options.workDir && language === 'bash') {
      effective = `cd ${shellQuote(options.workDir)} && ${code}`;
    }
    const { stdout, stderr, error, elapsedMs } = await this.executeRaw(
      effective,
      language,
      options.env,
      options.timeoutMs ?? 30_000
    );
    return { stdout, stderr, exitCode: error ? 1 : 0, executionTimeMs: elapsedMs, error };
  }

  /**
   * Run a shell command via the code interpreter's bash kernel.
   * Requires a code-interpreter template; exit codes are synthesized.
   */
  async runCommand(command: string, options: RunCommandOptions = {}): Promise<RunCommandResult> {
    let line = '';
    if (options.workingDir) line += `cd ${shellQuote(options.workingDir)} && `;
    line += command;
    for (const arg of options.args ?? []) line += ` ${shellQuote(arg)}`;
    const { stdout, stderr, error, elapsedMs } = await this.executeRaw(
      line,
      'bash',
      options.env,
      options.timeoutMs ?? 30_000
    );
    return { stdout, stderr, exitCode: error ? 1 : 0, executionTimeMs: elapsedMs, error };
  }

  async health(): Promise<HealthResult> {
    await check(
      'e2b',
      'health',
      await fetch(`${this.envdUrl}/health`, { headers: this.envdHeaders() })
    );
    return { status: 'running', sandboxId: this.sandboxId, uptimeMs: 0, backendKind: 'remote' };
  }

  async writeFile(path: string, content: Buffer | string): Promise<WriteFileResult> {
    const data = typeof content === 'string' ? Buffer.from(content) : content;
    const params = new URLSearchParams({ path, username: 'user' });
    await check(
      'e2b',
      'writeFile',
      await fetch(`${this.envdUrl}/files?${params}`, {
        method: 'POST',
        headers: this.envdHeaders({ 'Content-Type': 'application/octet-stream' }),
        body: new Uint8Array(data),
      })
    );
    return { success: true, path, size: data.length };
  }

  async readFile(path: string): Promise<ReadFileResult> {
    const params = new URLSearchParams({ path, username: 'user' });
    const resp = await check(
      'e2b',
      'readFile',
      await fetch(`${this.envdUrl}/files?${params}`, { headers: this.envdHeaders() })
    );
    const content = Buffer.from(await resp.arrayBuffer());
    return { path, content, size: content.length, isDir: false };
  }

  /** Unary Connect-RPC call to envd's filesystem service (JSON encoding). */
  private async filesystemRpc(method: string, body: Record<string, unknown>): Promise<any> {
    const resp = await check(
      'e2b',
      method,
      await fetch(`${this.envdUrl}/filesystem.Filesystem/${method}`, {
        method: 'POST',
        headers: this.envdHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      })
    );
    return resp.json();
  }

  async deleteFile(path: string, _recursive: boolean = false): Promise<boolean> {
    // envd's Remove deletes files and directories alike.
    await this.filesystemRpc('Remove', { path });
    return true;
  }

  async listFiles(path: string, recursive: boolean = false): Promise<ListFilesResult> {
    const data = await this.filesystemRpc('ListDir', { path, depth: recursive ? 64 : 1 });
    const files: FileInfo[] = (data.entries ?? []).map((entry: any) => ({
      name: entry.name ?? '',
      path: entry.path ?? '',
      // proto3 JSON serializes 64-bit ints as strings.
      size: Number(entry.size) || 0,
      mode: Number(entry.mode) || 0,
      isDir: entry.type === 'FILE_TYPE_DIRECTORY',
      modTime: entry.modifiedTime ? Date.parse(entry.modifiedTime) || 0 : 0,
    }));
    return { path, files, total: files.length };
  }
}

// ── Daytona ────────────────────────────────────────────────────

export interface DaytonaProviderOptions {
  apiKey: string;
  apiUrl?: string;
  /** Target region for new sandboxes (e.g. `us`). */
  target?: string;
  /** Seconds to wait for a new sandbox to reach `started`. Default 120. */
  readyTimeoutSecs?: number;
}

/** Control plane for Daytona sandboxes (https://daytona.io). */
export class DaytonaSandboxProvider {
  readonly name = 'daytona';
  private static readonly FAILED_STATES = new Set([
    'error',
    'build_failed',
    'destroyed',
    'destroying',
  ]);
  readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly target?: string;
  private readonly readyTimeoutSecs: number;

  constructor(options: DaytonaProviderOptions) {
    this.apiKey = options.apiKey;
    this.apiUrl = (options.apiUrl ?? 'https://app.daytona.io/api').replace(/\/$/, '');
    this.target = options.target;
    this.readyTimeoutSecs = options.readyTimeoutSecs ?? 120;
  }

  /** Build from DAYTONA_API_KEY (+ optional DAYTONA_API_URL, DAYTONA_TARGET). */
  static fromEnv(): DaytonaSandboxProvider {
    return new DaytonaSandboxProvider({
      apiKey: requireEnv('daytona', 'DAYTONA_API_KEY'),
      apiUrl: process.env.DAYTONA_API_URL,
      target: process.env.DAYTONA_TARGET,
    });
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
  }

  private async getSandbox(sandboxId: string): Promise<any> {
    const resp = await check(
      'daytona',
      'getSandbox',
      await fetch(`${this.apiUrl}/sandbox/${sandboxId}`, { headers: this.headers() })
    );
    return resp.json();
  }

  private async handle(data: any): Promise<DaytonaSandbox> {
    let proxyUrl: string | undefined = data.toolboxProxyUrl;
    if (!proxyUrl) {
      const resp = await check(
        'daytona',
        'toolboxProxyUrl',
        await fetch(`${this.apiUrl}/sandbox/${data.id}/toolbox-proxy-url`, {
          headers: this.headers(),
        })
      );
      proxyUrl = ((await resp.json()) as { url: string }).url;
    }
    return new DaytonaSandbox(
      data.id,
      `${proxyUrl!.replace(/\/$/, '')}/${data.id}`,
      this.apiUrl,
      this.headers()
    );
  }

  async create(opts: CreateSandboxOptions = {}): Promise<DaytonaSandbox> {
    const body: Record<string, unknown> = {};
    if (opts.template) body.snapshot = opts.template;
    if (opts.env) body.env = opts.env;
    if (opts.metadata) body.labels = opts.metadata;
    if (opts.cpuCores) body.cpu = opts.cpuCores;
    if (opts.memoryMib) body.memory = Math.ceil(opts.memoryMib / 1024); // GB
    if (opts.timeoutSecs) body.autoStopInterval = Math.ceil(opts.timeoutSecs / 60); // minutes
    if (this.target) body.target = this.target;

    const resp = await check(
      'daytona',
      'create',
      await fetch(`${this.apiUrl}/sandbox`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      })
    );
    let sandbox = (await resp.json()) as any;
    const deadline = Date.now() + this.readyTimeoutSecs * 1000;
    while (sandbox.state !== 'started') {
      if (DaytonaSandboxProvider.FAILED_STATES.has(sandbox.state)) {
        throw new SandboxProviderError(
          'daytona',
          'create',
          `sandbox ${sandbox.id} entered state '${sandbox.state}'`
        );
      }
      if (Date.now() >= deadline) {
        throw new SandboxProviderError(
          'daytona',
          'create',
          `sandbox ${sandbox.id} not started in ${this.readyTimeoutSecs}s`
        );
      }
      await new Promise((r) => global.setTimeout(r, 2000));
      sandbox = await this.getSandbox(sandbox.id);
    }
    return this.handle(sandbox);
  }

  async connect(sandboxId: string): Promise<DaytonaSandbox> {
    return this.handle(await this.getSandbox(sandboxId));
  }

  async destroy(sandboxId: string): Promise<boolean> {
    await check(
      'daytona',
      'destroy',
      await fetch(`${this.apiUrl}/sandbox/${sandboxId}`, {
        method: 'DELETE',
        headers: this.headers(),
      })
    );
    return true;
  }

  async listSandboxes(): Promise<SandboxInfo[]> {
    const resp = await check(
      'daytona',
      'listSandboxes',
      await fetch(`${this.apiUrl}/sandbox`, { headers: this.headers() })
    );
    const data = (await resp.json()) as { items?: Array<{ id?: string; state?: string }> };
    return (data.items ?? []).map((s) => ({
      sandboxId: s.id ?? '',
      status: s.state ?? 'unknown',
    }));
  }
}

/**
 * A running Daytona sandbox, driven via its toolbox daemon.
 *
 * Note: Daytona's exec API merges stdout and stderr; combined output is
 * reported as stdout.
 */
export class DaytonaSandbox {
  readonly languages = ['python', 'javascript', 'bash'];

  constructor(
    public readonly sandboxId: string,
    private readonly toolboxUrl: string,
    private readonly apiUrl: string,
    private readonly authHeaders: Record<string, string>
  ) {}

  async runCommand(command: string, options: RunCommandOptions = {}): Promise<RunCommandResult> {
    let line = command;
    for (const arg of options.args ?? []) line += ` ${shellQuote(arg)}`;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const body: Record<string, unknown> = {
      command: line,
      timeout: Math.max(1, Math.floor(timeoutMs / 1000)),
    };
    if (options.workingDir) body.cwd = options.workingDir;
    if (options.env) body.envs = options.env;
    const started = Date.now();
    const resp = await check(
      'daytona',
      'runCommand',
      await fetch(`${this.toolboxUrl}/process/execute`, {
        method: 'POST',
        headers: this.authHeaders,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs + 30_000),
      })
    );
    const data = (await resp.json()) as { exitCode?: number; result?: string };
    return {
      stdout: data.result ?? '',
      stderr: '',
      exitCode: data.exitCode ?? -1,
      executionTimeMs: Date.now() - started,
    };
  }

  async executeCode(
    code: string,
    language: string = 'python',
    options: { timeoutMs?: number; env?: Record<string, string>; workDir?: string } = {}
  ): Promise<ExecuteCodeResult> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (language === 'bash') {
      // Bash has no native code-run language; go through the shell.
      const [program, args] = interpreterArgv(language, code);
      const result = await this.runCommand(program, {
        args,
        workingDir: options.workDir,
        env: options.env,
        timeoutMs,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        executionTimeMs: result.executionTimeMs,
        error: result.error,
      };
    }
    const body: Record<string, unknown> = {
      code,
      language,
      timeout: Math.max(1, Math.floor(timeoutMs / 1000)),
    };
    if (options.env) body.envs = options.env;
    const started = Date.now();
    const resp = await check(
      'daytona',
      'executeCode',
      await fetch(`${this.toolboxUrl}/process/code-run`, {
        method: 'POST',
        headers: this.authHeaders,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs + 30_000),
      })
    );
    const data = (await resp.json()) as { exitCode?: number; result?: string };
    return {
      stdout: data.result ?? '',
      stderr: '',
      exitCode: data.exitCode ?? -1,
      executionTimeMs: Date.now() - started,
    };
  }

  async health(): Promise<HealthResult> {
    const resp = await check(
      'daytona',
      'health',
      await fetch(`${this.apiUrl}/sandbox/${this.sandboxId}`, { headers: this.authHeaders })
    );
    const data = (await resp.json()) as { state?: string };
    return {
      status: data.state ?? 'unknown',
      sandboxId: this.sandboxId,
      uptimeMs: 0,
      backendKind: 'remote',
    };
  }

  async writeFile(path: string, content: Buffer | string): Promise<WriteFileResult> {
    const data = typeof content === 'string' ? Buffer.from(content) : content;
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(data)]), path.split('/').pop() ?? 'file');
    const params = new URLSearchParams({ path });
    const headers = { ...this.authHeaders };
    delete (headers as Record<string, string>)['Content-Type']; // FormData sets its own boundary
    await check(
      'daytona',
      'writeFile',
      await fetch(`${this.toolboxUrl}/files/upload?${params}`, {
        method: 'POST',
        headers,
        body: form,
      })
    );
    return { success: true, path, size: data.length };
  }

  async readFile(path: string): Promise<ReadFileResult> {
    const params = new URLSearchParams({ path });
    const resp = await check(
      'daytona',
      'readFile',
      await fetch(`${this.toolboxUrl}/files/download?${params}`, { headers: this.authHeaders })
    );
    const content = Buffer.from(await resp.arrayBuffer());
    return { path, content, size: content.length, isDir: false };
  }

  async deleteFile(path: string, recursive: boolean = false): Promise<boolean> {
    const params = new URLSearchParams({ path, recursive: String(recursive) });
    await check(
      'daytona',
      'deleteFile',
      await fetch(`${this.toolboxUrl}/files?${params}`, {
        method: 'DELETE',
        headers: this.authHeaders,
      })
    );
    return true;
  }

  async listFiles(path: string, recursive: boolean = false): Promise<ListFilesResult> {
    if (recursive) {
      // The toolbox files API lists one directory; recurse via find.
      const result = await this.runCommand(
        `find ${shellQuote(path)} -mindepth 1 -printf '%y|%s|%m|%T@|%p\\n'`
      );
      if (result.exitCode !== 0) {
        throw new SandboxProviderError('daytona', 'listFiles', result.stdout);
      }
      const files = parseListingOutput(result.stdout);
      return { path, files, total: files.length };
    }
    const params = new URLSearchParams({ path });
    const resp = await check(
      'daytona',
      'listFiles',
      await fetch(`${this.toolboxUrl}/files?${params}`, { headers: this.authHeaders })
    );
    const entries = (await resp.json()) as any[];
    const files: FileInfo[] = entries.map((entry) => {
      let mode = 0;
      for (const candidate of [entry.permissions, entry.mode]) {
        if (candidate && /^[0-7]+$/.test(String(candidate))) {
          mode = parseInt(String(candidate), 8);
          break;
        }
      }
      return {
        name: entry.name ?? '',
        path: `${path.replace(/\/$/, '')}/${entry.name ?? ''}`,
        size: entry.size ?? 0,
        mode,
        isDir: entry.isDir ?? false,
        modTime: entry.modifiedAt ? Date.parse(entry.modifiedAt) || 0 : 0,
      };
    });
    return { path, files, total: files.length };
  }

  /** Public preview URL + access token for a sandbox port. */
  async previewUrl(port: number): Promise<{ url: string; token?: string }> {
    const resp = await check(
      'daytona',
      'previewUrl',
      await fetch(`${this.apiUrl}/sandbox/${this.sandboxId}/ports/${port}/preview-url`, {
        headers: this.authHeaders,
      })
    );
    return resp.json() as Promise<{ url: string; token?: string }>;
  }

  // ----- Git (native toolbox endpoints) -----

  async gitClone(
    url: string,
    options: {
      targetDir?: string;
      branch?: string;
      username?: string;
      password?: string;
    } = {}
  ): Promise<{ success: boolean; path: string; branch: string }> {
    const path =
      options.targetDir ??
      (url.replace(/\/$/, '').split('/').pop() ?? 'repo').replace(/\.git$/, '');
    const body: Record<string, unknown> = { url, path };
    if (options.branch) body.branch = options.branch;
    if (options.username) body.username = options.username;
    if (options.password) body.password = options.password;
    await check(
      'daytona',
      'gitClone',
      await fetch(`${this.toolboxUrl}/git/clone`, {
        method: 'POST',
        headers: this.authHeaders,
        body: JSON.stringify(body),
      })
    );
    return { success: true, path, branch: options.branch ?? '' };
  }

  async gitCommit(
    message: string,
    options: { path?: string; files?: string[]; author?: string } = {}
  ): Promise<{ success: boolean; commitSha: string }> {
    const path = options.path ?? '.';
    await check(
      'daytona',
      'gitAdd',
      await fetch(`${this.toolboxUrl}/git/add`, {
        method: 'POST',
        headers: this.authHeaders,
        body: JSON.stringify({ path, files: options.files ?? ['.'] }),
      })
    );
    // The toolbox requires separate author name and email fields.
    const author = options.author ?? 'AGNT5 <agnt5@agnt5.dev>';
    const match = author.match(/^(.*?)<(.*)>$/);
    const name = (match?.[1] ?? author).trim();
    const email = (match?.[2] ?? 'agnt5@agnt5.dev').trim();
    const resp = await check(
      'daytona',
      'gitCommit',
      await fetch(`${this.toolboxUrl}/git/commit`, {
        method: 'POST',
        headers: this.authHeaders,
        body: JSON.stringify({ path, message, author: name, email }),
      })
    );
    const data = (await resp.json().catch(() => ({}))) as { hash?: string };
    return { success: true, commitSha: data.hash ?? '' };
  }

  async gitPush(
    options: { path?: string; username?: string; password?: string } = {}
  ): Promise<{ success: boolean }> {
    const body: Record<string, unknown> = { path: options.path ?? '.' };
    if (options.username) body.username = options.username;
    if (options.password) body.password = options.password;
    await check(
      'daytona',
      'gitPush',
      await fetch(`${this.toolboxUrl}/git/push`, {
        method: 'POST',
        headers: this.authHeaders,
        body: JSON.stringify(body),
      })
    );
    return { success: true };
  }
}

// ── Vercel ─────────────────────────────────────────────────────

export interface VercelProviderOptions {
  /** Bearer token: an OIDC token or a Vercel access token. */
  token: string;
  teamId?: string;
  projectId?: string;
  baseUrl?: string;
}

/**
 * Control plane for Vercel Sandboxes (https://vercel.com/docs/sandbox).
 *
 * Auth modes (matching `@vercel/sandbox`): an OIDC token alone, or an
 * access token + teamId + projectId.
 */
export class VercelSandboxProvider {
  readonly name = 'vercel';
  readonly baseUrl: string;
  private readonly token: string;
  private readonly teamId?: string;
  private readonly projectId?: string;

  constructor(options: VercelProviderOptions) {
    this.token = options.token;
    this.teamId = options.teamId;
    this.projectId = options.projectId;
    this.baseUrl = (options.baseUrl ?? 'https://api.vercel.com').replace(/\/$/, '');
  }

  /** Build from VERCEL_OIDC_TOKEN, or VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID. */
  static fromEnv(): VercelSandboxProvider {
    const baseUrl = process.env.VERCEL_SANDBOX_BASE_URL;
    const oidc = process.env.VERCEL_OIDC_TOKEN;
    if (oidc) {
      return new VercelSandboxProvider({
        token: oidc,
        teamId: process.env.VERCEL_TEAM_ID,
        projectId: process.env.VERCEL_PROJECT_ID,
        baseUrl,
      });
    }
    const token = requireEnv('vercel', 'VERCEL_TOKEN');
    const teamId = process.env.VERCEL_TEAM_ID;
    const projectId = process.env.VERCEL_PROJECT_ID;
    if (!teamId || !projectId) {
      throw new SandboxProviderError(
        'vercel',
        'fromEnv',
        'VERCEL_TEAM_ID and VERCEL_PROJECT_ID are required with VERCEL_TOKEN'
      );
    }
    return new VercelSandboxProvider({ token, teamId, projectId, baseUrl });
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' };
  }

  private params(extra: Record<string, string> = {}): string {
    const params = new URLSearchParams(extra);
    if (this.teamId) params.set('teamId', this.teamId);
    if (this.projectId) params.set('projectId', this.projectId);
    const s = params.toString();
    return s ? `?${s}` : '';
  }

  private handle(data: any): VercelSandbox {
    return new VercelSandbox(
      data.sandbox?.name ?? '',
      data.session.id,
      data.routes ?? [],
      this.baseUrl,
      this.params(),
      this.headers()
    );
  }

  async create(opts: CreateSandboxOptions = {}): Promise<VercelSandbox> {
    const body: Record<string, unknown> = {
      name: `agnt5-${crypto.randomUUID().replace(/-/g, '')}`,
      runtime: opts.template ?? 'node24',
      timeout: (opts.timeoutSecs ?? 300) * 1000,
    };
    if (opts.cpuCores) body.resources = { vcpus: opts.cpuCores };
    if (opts.env) body.env = opts.env;
    if (this.projectId) body.projectId = this.projectId;
    const resp = await check(
      'vercel',
      'create',
      await fetch(`${this.baseUrl}/v2/sandboxes${this.params()}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      })
    );
    return this.handle(await resp.json());
  }

  /** Connect to an existing sandbox by name, resuming it if stopped. */
  async connect(name: string): Promise<VercelSandbox> {
    const resp = await check(
      'vercel',
      'connect',
      await fetch(`${this.baseUrl}/v2/sandboxes/${name}${this.params({ resume: 'true' })}`, {
        headers: this.headers(),
      })
    );
    return this.handle(await resp.json());
  }

  async destroy(name: string): Promise<boolean> {
    await check(
      'vercel',
      'destroy',
      await fetch(`${this.baseUrl}/v2/sandboxes/${name}${this.params()}`, {
        method: 'DELETE',
        headers: this.headers(),
      })
    );
    return true;
  }

  async listSandboxes(): Promise<SandboxInfo[]> {
    const resp = await check(
      'vercel',
      'listSandboxes',
      await fetch(`${this.baseUrl}/v2/sandboxes${this.params()}`, { headers: this.headers() })
    );
    const data = (await resp.json()) as { sandboxes?: Array<{ name?: string; status?: string }> };
    return (data.sandboxes ?? []).map((s) => ({
      sandboxId: s.name ?? '',
      status: s.status ?? 'unknown',
    }));
  }
}

/** A running Vercel Sandbox session. */
export class VercelSandbox {
  readonly languages = ['python', 'javascript', 'bash'];

  constructor(
    public readonly name: string,
    public readonly sessionId: string,
    public readonly routes: Array<{ url: string; port: number }>,
    private readonly baseUrl: string,
    private readonly query: string,
    private readonly authHeaders: Record<string, string>
  ) {}

  get sandboxId(): string {
    return this.name;
  }

  /** Public URL for a port declared at sandbox creation. */
  previewUrl(port: number): string | undefined {
    return this.routes.find((r) => r.port === port)?.url;
  }

  private sessionUrl(suffix: string = ''): string {
    return `${this.baseUrl}/v2/sandboxes/sessions/${this.sessionId}${suffix}${this.query}`;
  }

  async runCommand(
    command: string,
    options: RunCommandOptions & { sudo?: boolean } = {}
  ): Promise<RunCommandResult> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const body: Record<string, unknown> = {
      command,
      args: options.args ?? [],
      wait: true,
      logs: true,
      timeout: timeoutMs,
    };
    if (options.workingDir) body.cwd = options.workingDir;
    if (options.env) body.env = options.env;
    if (options.sudo) body.sudo = true;
    const started = Date.now();
    const resp = await check(
      'vercel',
      'runCommand',
      await fetch(this.sessionUrl('/cmd'), {
        method: 'POST',
        headers: this.authHeaders,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs + 30_000),
      })
    );
    let stdout = '';
    let stderr = '';
    let exitCode = -1;
    let error: string | undefined;
    // ND-JSON stream: log lines carry stream/data; command lines carry exitCode.
    for (const line of (await resp.text()).split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: any;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (event.stream === 'stdout' && typeof event.data === 'string') stdout += event.data;
      else if (event.stream === 'stderr' && typeof event.data === 'string') stderr += event.data;
      else if (event.stream === 'error') {
        error = typeof event.data === 'object' ? event.data?.message : String(event.data);
      }
      if (event.command && event.command.exitCode !== null && event.command.exitCode !== undefined) {
        exitCode = event.command.exitCode;
      }
    }
    return { stdout, stderr, exitCode, executionTimeMs: Date.now() - started, error };
  }

  async executeCode(
    code: string,
    language: string = 'python',
    options: { timeoutMs?: number; env?: Record<string, string>; workDir?: string } = {}
  ): Promise<ExecuteCodeResult> {
    const [program, args] = interpreterArgv(language, code);
    const result = await this.runCommand(program, {
      args,
      workingDir: options.workDir,
      env: options.env,
      timeoutMs: options.timeoutMs,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      executionTimeMs: result.executionTimeMs,
      error: result.error,
    };
  }

  async health(): Promise<HealthResult> {
    const resp = await check(
      'vercel',
      'health',
      await fetch(this.sessionUrl(), { headers: this.authHeaders })
    );
    const data = (await resp.json()) as any;
    return {
      status: data.status ?? data.session?.status ?? 'unknown',
      sandboxId: this.name,
      uptimeMs: 0,
      backendKind: 'remote',
    };
  }

  async writeFile(path: string, content: Buffer | string, mode: number = 0o644): Promise<WriteFileResult> {
    const data = typeof content === 'string' ? Buffer.from(content) : content;
    // fs/write takes a gzipped tar; entry paths resolve against x-cwd.
    const [cwd, entry] = path.startsWith('/') ? ['/', path.slice(1)] : ['/vercel/sandbox', path];
    const archive = gzipSync(buildTar(entry, data, mode));
    await check(
      'vercel',
      'writeFile',
      await fetch(this.sessionUrl('/fs/write'), {
        method: 'POST',
        headers: {
          ...this.authHeaders,
          'Content-Type': 'application/gzip',
          'x-cwd': cwd,
        },
        body: new Uint8Array(archive),
      })
    );
    return { success: true, path, size: data.length };
  }

  async readFile(path: string): Promise<ReadFileResult> {
    const resp = await check(
      'vercel',
      'readFile',
      await fetch(this.sessionUrl('/fs/read'), {
        method: 'POST',
        headers: this.authHeaders,
        body: JSON.stringify({ path }),
      })
    );
    const content = Buffer.from(await resp.arrayBuffer());
    return { path, content, size: content.length, isDir: false };
  }

  async deleteFile(path: string, recursive: boolean = false): Promise<boolean> {
    const args = ['-f', ...(recursive ? ['-r'] : []), '--', path];
    const result = await this.runCommand('rm', { args });
    return result.exitCode === 0;
  }

  async listFiles(path: string, recursive: boolean = false): Promise<ListFilesResult> {
    // Amazon Linux 2023 ships GNU findutils, so -printf is available.
    const args = [path, '-mindepth', '1'];
    if (!recursive) args.push('-maxdepth', '1');
    args.push('-printf', '%y|%s|%m|%T@|%p\\n');
    const result = await this.runCommand('find', { args });
    if (result.exitCode !== 0) {
      throw new SandboxProviderError('vercel', 'listFiles', result.stderr);
    }
    const files = parseListingOutput(result.stdout);
    return { path, files, total: files.length };
  }
}

/** Build a single-file POSIX (ustar) tar archive in memory. */
function buildTar(entryPath: string, content: Buffer, mode: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(entryPath, 0, 100, 'utf8'); // name
  header.write(mode.toString(8).padStart(7, '0'), 100, 8); // mode
  header.write('0000000', 108, 8); // uid
  header.write('0000000', 116, 8); // gid
  header.write(content.length.toString(8).padStart(11, '0'), 124, 12); // size
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0'), 136, 12); // mtime
  header.write('        ', 148, 8); // checksum placeholder (spaces)
  header.write('0', 156, 1); // typeflag: regular file
  header.write('ustar', 257, 6); // magic
  header.write('00', 263, 2); // version
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);

  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  const trailer = Buffer.alloc(1024); // two zero blocks
  return Buffer.concat([header, content, padding, trailer]);
}

// ── Northflank ─────────────────────────────────────────────────

export interface NorthflankProviderOptions {
  apiToken: string;
  projectId: string;
  /** Required for team-scoped tokens (adds `teams/{id}/` to exec paths). */
  teamId?: string;
  baseUrl?: string;
  /** Compute plan for sandbox services. Default `nf-compute-200`. */
  deploymentPlan?: string;
  /** Default container image. Default `python:3.12-slim-bookworm`. */
  image?: string;
  /** Seconds to wait for a new service's deployment (includes image pull). Default 180. */
  readyTimeoutSecs?: number;
}

/**
 * Control plane for Northflank sandboxes (https://northflank.com).
 *
 * Sandboxes are deployment services running `sleep infinity`; commands run
 * over the command-exec websocket (requires the global `WebSocket`,
 * available in Node >= 22). File operations are emulated over exec.
 */
export class NorthflankSandboxProvider {
  readonly name = 'northflank';
  readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly projectId: string;
  private readonly teamId?: string;
  private readonly deploymentPlan: string;
  private readonly image: string;
  private readonly readyTimeoutSecs: number;

  constructor(options: NorthflankProviderOptions) {
    this.apiToken = options.apiToken;
    this.projectId = options.projectId;
    this.teamId = options.teamId;
    this.baseUrl = (options.baseUrl ?? 'https://api.northflank.com').replace(/\/$/, '');
    this.deploymentPlan = options.deploymentPlan ?? 'nf-compute-200';
    this.image = options.image ?? 'python:3.12-slim-bookworm';
    this.readyTimeoutSecs = options.readyTimeoutSecs ?? 180;
  }

  /** Build from NORTHFLANK_API_TOKEN + NORTHFLANK_PROJECT_ID (+ optional vars). */
  static fromEnv(): NorthflankSandboxProvider {
    return new NorthflankSandboxProvider({
      apiToken: requireEnv('northflank', 'NORTHFLANK_API_TOKEN'),
      projectId: requireEnv('northflank', 'NORTHFLANK_PROJECT_ID'),
      teamId: process.env.NORTHFLANK_TEAM_ID,
      baseUrl: process.env.NORTHFLANK_API_URL,
      deploymentPlan: process.env.NORTHFLANK_DEPLOYMENT_PLAN,
      image: process.env.NORTHFLANK_SANDBOX_IMAGE,
    });
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' };
  }

  private serviceUrl(serviceId: string): string {
    return `${this.baseUrl}/v1/projects/${this.projectId}/services/${serviceId}`;
  }

  /** Extract a human-readable deployment status from the service status blob. */
  static deploymentStatus(status: any): string {
    if (!status || typeof status !== 'object') return 'unknown';
    const deployment = status.deployment ?? status;
    if (deployment && typeof deployment === 'object') {
      return String(deployment.status ?? JSON.stringify(deployment));
    }
    return String(deployment);
  }

  private handle(serviceId: string): NorthflankSandbox {
    return new NorthflankSandbox(
      serviceId,
      this.projectId,
      this.apiToken,
      this.teamId,
      this.baseUrl,
      this.headers()
    );
  }

  async create(opts: CreateSandboxOptions = {}): Promise<NorthflankSandbox> {
    const body: Record<string, unknown> = {
      name: `agnt5-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      billing: { deploymentPlan: this.deploymentPlan },
      deployment: {
        external: { imagePath: opts.template ?? this.image },
        docker: { configType: 'customCommand', customCommand: 'sleep infinity' },
      },
    };
    if (opts.env) body.runtimeEnvironment = opts.env;
    const resp = await check(
      'northflank',
      'create',
      await fetch(`${this.baseUrl}/v1/projects/${this.projectId}/services/deployment`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      })
    );
    const serviceId = ((await resp.json()) as { data: { id: string } }).data.id;

    const deadline = Date.now() + this.readyTimeoutSecs * 1000;
    for (;;) {
      const statusResp = await check(
        'northflank',
        'getService',
        await fetch(this.serviceUrl(serviceId), { headers: this.headers() })
      );
      const data = ((await statusResp.json()) as { data: { status?: unknown } }).data;
      const status = NorthflankSandboxProvider.deploymentStatus(data.status).toLowerCase();
      if (status.includes('running') || status.includes('completed')) break;
      if (status.includes('failed') || status.includes('error')) {
        throw new SandboxProviderError(
          'northflank',
          'create',
          `service ${serviceId} failed (${status})`
        );
      }
      if (Date.now() >= deadline) {
        throw new SandboxProviderError(
          'northflank',
          'create',
          `service ${serviceId} not running in ${this.readyTimeoutSecs}s (${status})`
        );
      }
      await new Promise((r) => global.setTimeout(r, 3000));
    }
    return this.handle(serviceId);
  }

  async connect(serviceId: string): Promise<NorthflankSandbox> {
    await check(
      'northflank',
      'connect',
      await fetch(this.serviceUrl(serviceId), { headers: this.headers() })
    );
    return this.handle(serviceId);
  }

  async destroy(serviceId: string): Promise<boolean> {
    await check(
      'northflank',
      'destroy',
      await fetch(this.serviceUrl(serviceId), { method: 'DELETE', headers: this.headers() })
    );
    return true;
  }

  async listSandboxes(): Promise<SandboxInfo[]> {
    const resp = await check(
      'northflank',
      'listSandboxes',
      await fetch(`${this.baseUrl}/v1/projects/${this.projectId}/services`, {
        headers: this.headers(),
      })
    );
    const data = (await resp.json()) as { data?: { services?: any[] } };
    return (data.data?.services ?? []).map((s) => ({
      sandboxId: s.id ?? '',
      status: NorthflankSandboxProvider.deploymentStatus(s.status),
    }));
  }
}

/** A running Northflank sandbox service. */
export class NorthflankSandbox {
  readonly languages = ['python', 'javascript', 'bash'];

  constructor(
    public readonly serviceId: string,
    private readonly projectId: string,
    private readonly apiToken: string,
    private readonly teamId: string | undefined,
    private readonly baseUrl: string,
    private readonly authHeaders: Record<string, string>
  ) {}

  get sandboxId(): string {
    return this.serviceId;
  }

  /** Build the exec websocket URL, including the team prefix when present. */
  wsUrl(): string {
    const wsBase = this.baseUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    const team = this.teamId ? `teams/${this.teamId}/` : '';
    return `${wsBase}/v1/command-exec/${team}projects/${this.projectId}/services/${this.serviceId}`;
  }

  /** Run a command over the command-exec websocket. */
  async runCommand(command: string, options: RunCommandOptions = {}): Promise<RunCommandResult> {
    if (typeof WebSocket === 'undefined') {
      throw new SandboxProviderError(
        'northflank',
        'runCommand',
        'the global WebSocket API is required for Northflank exec (Node >= 22)'
      );
    }
    let argv = [command, ...(options.args ?? [])];
    if (options.workingDir || options.env) {
      // The exec context has no cwd/env parameters; wrap in a shell.
      let line = '';
      if (options.workingDir) line += `cd ${shellQuote(options.workingDir)} && `;
      for (const [key, value] of Object.entries(options.env ?? {})) {
        line += `export ${key}=${shellQuote(value)} && `;
      }
      line += argv.map(shellQuote).join(' ');
      argv = ['bash', '-c', line];
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    const started = Date.now();

    return new Promise<RunCommandResult>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl());
      let stdout = '';
      let stderr = '';
      let exitCode = -1;
      let settled = false;

      const timer = global.setTimeout(() => {
        fail(new SandboxProviderError('northflank', 'runCommand', `timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      const finish = () => {
        if (settled) return;
        settled = true;
        global.clearTimeout(timer);
        ws.close();
        resolve({ stdout, stderr, exitCode, executionTimeMs: Date.now() - started });
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        global.clearTimeout(timer);
        ws.close();
        reject(err);
      };

      ws.onopen = () => {
        // Auth is in-band: the first message carries the API token.
        ws.send(
          JSON.stringify({
            type: 'init',
            data: {
              auth: { type: 'apiToken', apiToken: this.apiToken },
              context: { command: argv },
            },
          })
        );
      };
      ws.onmessage = (event: MessageEvent) => {
        let msg: any;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const data = msg.data;
        switch (msg.type) {
          case 'init': {
            const auth = typeof data === 'object' ? data?.auth : data;
            if (auth !== 'successful') {
              fail(new SandboxProviderError('northflank', 'runCommand', `auth failed: ${JSON.stringify(msg)}`));
            }
            break;
          }
          case 'stdOut':
            if (typeof data === 'string') stdout += data;
            break;
          case 'stdErr':
            if (typeof data === 'string') stderr += data;
            break;
          case 'completion':
            if (data && typeof data.exitCode === 'number') exitCode = data.exitCode;
            finish();
            break;
          case 'error':
            fail(
              new SandboxProviderError(
                'northflank',
                'runCommand',
                typeof data === 'object' ? (data?.message ?? 'unknown error') : String(data)
              )
            );
            break;
        }
      };
      ws.onerror = () => fail(new SandboxProviderError('northflank', 'runCommand', 'websocket error'));
      ws.onclose = () => finish();
    });
  }

  async executeCode(
    code: string,
    language: string = 'python',
    options: { timeoutMs?: number; env?: Record<string, string>; workDir?: string } = {}
  ): Promise<ExecuteCodeResult> {
    const [program, args] = interpreterArgv(language, code);
    const result = await this.runCommand(program, {
      args,
      workingDir: options.workDir,
      env: options.env,
      timeoutMs: options.timeoutMs,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      executionTimeMs: result.executionTimeMs,
      error: result.error,
    };
  }

  async health(): Promise<HealthResult> {
    const resp = await check(
      'northflank',
      'health',
      await fetch(`${this.baseUrl}/v1/projects/${this.projectId}/services/${this.serviceId}`, {
        headers: this.authHeaders,
      })
    );
    const data = (await resp.json()) as { data?: { status?: unknown } };
    return {
      status: NorthflankSandboxProvider.deploymentStatus(data.data?.status),
      sandboxId: this.serviceId,
      uptimeMs: 0,
      backendKind: 'remote',
    };
  }

  async writeFile(path: string, content: Buffer | string, mode: number = 0o644): Promise<WriteFileResult> {
    const data = typeof content === 'string' ? Buffer.from(content) : content;
    const encoded = data.toString('base64');
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) || '/' : '.';
    const script =
      `mkdir -p ${shellQuote(parent)} && ` +
      `printf '%s' ${shellQuote(encoded)} | base64 -d > ${shellQuote(path)} && ` +
      `chmod ${mode.toString(8)} ${shellQuote(path)}`;
    const result = await this.runCommand('bash', { args: ['-c', script], timeoutMs: 60_000 });
    if (result.exitCode !== 0) {
      throw new SandboxProviderError('northflank', 'writeFile', result.stderr);
    }
    return { success: true, path, size: data.length };
  }

  async readFile(path: string): Promise<ReadFileResult> {
    const result = await this.runCommand('base64', { args: [path], timeoutMs: 60_000 });
    if (result.exitCode !== 0) {
      throw new SandboxProviderError('northflank', 'readFile', result.stderr);
    }
    const content = Buffer.from(result.stdout.replace(/\s/g, ''), 'base64');
    return { path, content, size: content.length, isDir: false };
  }

  async deleteFile(path: string, recursive: boolean = false): Promise<boolean> {
    const args = ['-f', ...(recursive ? ['-r'] : []), '--', path];
    const result = await this.runCommand('rm', { args });
    return result.exitCode === 0;
  }

  async listFiles(path: string, recursive: boolean = false): Promise<ListFilesResult> {
    const args = [path, '-mindepth', '1'];
    if (!recursive) args.push('-maxdepth', '1');
    args.push('-printf', '%y|%s|%m|%T@|%p\\n');
    const result = await this.runCommand('find', { args });
    if (result.exitCode !== 0) {
      throw new SandboxProviderError('northflank', 'listFiles', result.stderr);
    }
    const files = parseListingOutput(result.stdout);
    return { path, files, total: files.length };
  }
}

// ── Together ───────────────────────────────────────────────────

export interface TogetherProviderOptions {
  apiKey: string;
  baseUrl?: string;
}

/**
 * Control plane for Together Code Interpreter sessions (https://together.ai).
 *
 * Sessions persist packages/variables for 60 minutes and cannot be
 * destroyed (they expire on their own). Only Python execution is
 * supported; file operations are emulated via session-side snippets and
 * TCI's native files upload.
 */
export class TogetherSandboxProvider {
  readonly name = 'together';
  readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: TogetherProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.together.ai').replace(/\/$/, '');
  }

  /** Build from TOGETHER_API_KEY (+ optional TOGETHER_BASE_URL). */
  static fromEnv(): TogetherSandboxProvider {
    return new TogetherSandboxProvider({
      apiKey: requireEnv('together', 'TOGETHER_API_KEY'),
      baseUrl: process.env.TOGETHER_BASE_URL,
    });
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
  }

  /** @internal Execute code in a TCI session, optionally uploading files first. */
  async execute(
    code: string,
    sessionId?: string,
    files?: Array<{ name: string; encoding: string; content: string }>,
    timeoutMs: number = 60_000
  ): Promise<any> {
    const body: Record<string, unknown> = { code, language: 'python' };
    if (sessionId) body.session_id = sessionId;
    if (files) body.files = files;
    const resp = await check(
      'together',
      'execute',
      await fetch(`${this.baseUrl}/v1/tci/execute`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs + 30_000),
      })
    );
    const parsed = (await resp.json()) as { data?: any; errors?: unknown };
    if (parsed.errors && (!Array.isArray(parsed.errors) || parsed.errors.length > 0)) {
      throw new SandboxProviderError('together', 'execute', JSON.stringify(parsed.errors));
    }
    if (!parsed.data) {
      throw new SandboxProviderError('together', 'execute', 'response missing data');
    }
    return parsed.data;
  }

  /** @internal */
  async sessions(): Promise<Array<{ id?: string }>> {
    const resp = await check(
      'together',
      'sessions',
      await fetch(`${this.baseUrl}/v1/tci/sessions`, { headers: this.headers() })
    );
    const parsed = (await resp.json()) as { data?: { sessions?: Array<{ id?: string }> } };
    return parsed.data?.sessions ?? [];
  }

  async create(_opts: CreateSandboxOptions = {}): Promise<TogetherSandbox> {
    // Sessions are created implicitly; a no-op execution materializes one.
    const data = await this.execute('pass');
    if (!data.session_id) {
      throw new SandboxProviderError('together', 'create', 'no session_id returned');
    }
    return new TogetherSandbox(data.session_id, this);
  }

  async connect(sessionId: string): Promise<TogetherSandbox> {
    const sessions = await this.sessions();
    if (!sessions.some((s) => s.id === sessionId)) {
      throw new SandboxProviderError(
        'together',
        'connect',
        `session '${sessionId}' not found or expired`
      );
    }
    return new TogetherSandbox(sessionId, this);
  }

  async destroy(_sessionId: string): Promise<boolean> {
    throw new SandboxProviderError(
      'together',
      'destroy',
      'TCI sessions cannot be destroyed; they expire after 60 minutes'
    );
  }

  async listSandboxes(): Promise<SandboxInfo[]> {
    return (await this.sessions()).map((s) => ({ sandboxId: s.id ?? '', status: 'running' }));
  }
}

/** A live Together Code Interpreter session. */
export class TogetherSandbox {
  readonly languages = ['python'];

  constructor(
    public readonly sessionId: string,
    private readonly provider: TogetherSandboxProvider
  ) {}

  get sandboxId(): string {
    return this.sessionId;
  }

  /** Map TCI outputs onto stdout/stderr/error. */
  static mapOutputs(data: any): ExecuteCodeResult {
    let stdout = '';
    let stderr = '';
    let error: string | undefined;
    for (const output of data.outputs ?? []) {
      const value = output.data;
      if (output.type === 'stdout' && typeof value === 'string') stdout += value;
      else if (output.type === 'stderr' && typeof value === 'string') stderr += value;
      else if (output.type === 'error') error = typeof value === 'string' ? value : JSON.stringify(value);
      else if (value && typeof value === 'object' && 'text/plain' in value) {
        stdout += String(value['text/plain']);
      }
    }
    const succeeded = !error && (data.status === 'success' || data.status === 'completed');
    return { stdout, stderr, exitCode: succeeded ? 0 : 1, executionTimeMs: 0, error };
  }

  async executeCode(
    code: string,
    language: string = 'python',
    options: { timeoutMs?: number } = {}
  ): Promise<ExecuteCodeResult> {
    if (language !== 'python') {
      throw new SandboxProviderError(
        'together',
        'executeCode',
        `Together Code Interpreter only supports Python (requested: ${language})`
      );
    }
    const started = Date.now();
    const data = await this.provider.execute(code, this.sessionId, undefined, options.timeoutMs);
    const result = TogetherSandbox.mapOutputs(data);
    result.executionTimeMs = Date.now() - started;
    return result;
  }

  private async runPython(code: string, operation: string): Promise<ExecuteCodeResult> {
    const data = await this.provider.execute(code, this.sessionId);
    const result = TogetherSandbox.mapOutputs(data);
    if (result.error) {
      throw new SandboxProviderError('together', operation, result.error);
    }
    return result;
  }

  async health(): Promise<HealthResult> {
    const sessions = await this.provider.sessions();
    const alive = sessions.some((s) => s.id === this.sessionId);
    return {
      status: alive ? 'running' : 'expired',
      sandboxId: this.sessionId,
      uptimeMs: 0,
      backendKind: 'remote',
    };
  }

  async writeFile(path: string, content: Buffer | string): Promise<WriteFileResult> {
    const data = typeof content === 'string' ? Buffer.from(content) : content;
    await this.provider.execute('pass', this.sessionId, [
      { name: path, encoding: 'base64', content: data.toString('base64') },
    ]);
    return { success: true, path, size: data.length };
  }

  async readFile(path: string): Promise<ReadFileResult> {
    const code =
      `import base64, sys\n` +
      `sys.stdout.write(base64.b64encode(open(${JSON.stringify(path)}, 'rb').read()).decode())`;
    const result = await this.runPython(code, 'readFile');
    const content = Buffer.from(result.stdout.replace(/\s/g, ''), 'base64');
    return { path, content, size: content.length, isDir: false };
  }

  async deleteFile(path: string, recursive: boolean = false): Promise<boolean> {
    const code =
      `import os, shutil\n` +
      `p = ${JSON.stringify(path)}\n` +
      `if os.path.isdir(p) and not os.path.islink(p):\n` +
      `    shutil.rmtree(p) if ${recursive ? 'True' : 'False'} else os.rmdir(p)\n` +
      `else:\n` +
      `    os.remove(p)`;
    await this.runPython(code, 'deleteFile');
    return true;
  }

  async listFiles(path: string, recursive: boolean = false): Promise<ListFilesResult> {
    const code =
      `import os\n` +
      `p = ${JSON.stringify(path)}\n` +
      `entries = []\n` +
      `if ${recursive ? 'True' : 'False'}:\n` +
      `    for dirpath, dirnames, filenames in os.walk(p):\n` +
      `        entries.extend(os.path.join(dirpath, n) for n in dirnames + filenames)\n` +
      `else:\n` +
      `    entries = [os.path.join(p, n) for n in os.listdir(p)]\n` +
      `for e in entries:\n` +
      `    st = os.lstat(e)\n` +
      `    kind = 'd' if os.path.isdir(e) and not os.path.islink(e) else 'f'\n` +
      `    print(f"{kind}|{st.st_size}|{oct(st.st_mode & 0o7777)[2:]}|{st.st_mtime}|{e}")`;
    const result = await this.runPython(code, 'listFiles');
    const files = parseListingOutput(result.stdout);
    return { path, files, total: files.length };
  }
}

// ── Env auto-detection ─────────────────────────────────────────

export type SandboxProvider =
  | E2BSandboxProvider
  | DaytonaSandboxProvider
  | VercelSandboxProvider
  | NorthflankSandboxProvider
  | TogetherSandboxProvider;

/**
 * Detect and construct providers from environment variables.
 *
 * Mirrors the Rust `SandboxRegistry::load_providers_from_environment`:
 * a partially configured provider throws rather than being silently
 * skipped. Construction is lazy — no network calls are made.
 *
 * Triggers: E2B_API_KEY, DAYTONA_API_KEY, VERCEL_OIDC_TOKEN/VERCEL_TOKEN,
 * NORTHFLANK_API_TOKEN, TOGETHER_API_KEY.
 */
export function loadProvidersFromEnv(): Record<string, SandboxProvider> {
  const providers: Record<string, SandboxProvider> = {};
  if (process.env.E2B_API_KEY) providers.e2b = E2BSandboxProvider.fromEnv();
  if (process.env.DAYTONA_API_KEY) providers.daytona = DaytonaSandboxProvider.fromEnv();
  if (process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL_TOKEN) {
    providers.vercel = VercelSandboxProvider.fromEnv();
  }
  if (process.env.NORTHFLANK_API_TOKEN) providers.northflank = NorthflankSandboxProvider.fromEnv();
  if (process.env.TOGETHER_API_KEY) providers.together = TogetherSandboxProvider.fromEnv();
  return providers;
}

// Internal helpers exported for unit tests.
export const _internal = { interpreterArgv, shellQuote, parseListingOutput, buildTar };
