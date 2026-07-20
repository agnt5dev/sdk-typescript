/**
 * Sandbox — secure code execution and file I/O.
 *
 * Supports provider-backed sandboxes by default, plus explicit native
 * remote/WASM backends when `backend` is configured.
 *
 * @example
 * ```ts
 * import { Sandbox } from '@agnt5/sdk';
 *
 * const sandbox = new Sandbox({ provider: 'e2b' }); // or new Sandbox() to auto-detect
 * const result = await sandbox.executeCode('console.log("hello")', 'javascript');
 * console.log(result.stdout); // "hello"
 * ```
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProvidersFromEnv } from './sandbox-providers.js';
import type { CreateSandboxOptions, SandboxProvider } from './sandbox-providers.js';

// ── Types ──────────────────────────────────────────────────────

export interface SandboxOptions {
  /** Provider selection: "e2b", "daytona", "vercel", etc. */
  provider?: string;
  /** Backend selection: "remote", "wasm", or "auto" (default). */
  backend?: string;
  /** HTTP endpoint for remote backend. */
  endpoint?: string;
  /** Sandbox instance ID. */
  sandboxId?: string;
  /** API key for remote auth. */
  apiKey?: string;
  /** Bearer token for remote auth. */
  bearerToken?: string;
  /** Request timeout in seconds for native sandboxes; provider lifetime when provider-backed. */
  timeoutSecs?: number;
  /** Path to QuickJS WASI binary (for wasm backend). */
  quickjsWasmPath?: string;
  /** Destroy provider sandboxes after close (default: true). */
  autoDestroy?: boolean;
  /** Template, snapshot, or image identifier for provider-backed sandboxes. */
  template?: string;
  /** Environment variables available inside provider-backed sandboxes. */
  env?: Record<string, string>;
  /** Provider metadata/labels. */
  metadata?: Record<string, string>;
  /** CPU cores to allocate when supported by the provider. */
  cpuCores?: number;
  /** Memory in MiB when supported by the provider. */
  memoryMib?: number;
}

export interface ExecuteCodeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTimeMs: number;
  error?: string;
}

export interface WriteFileResult {
  success: boolean;
  path: string;
  size: number;
  error?: string;
}

export interface ReadFileResult {
  path: string;
  content: Buffer;
  size: number;
  isDir: boolean;
  error?: string;
}

export interface FileInfo {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
  mode: number;
  modTime: number;
}

export interface ListFilesResult {
  path: string;
  total: number;
  files: FileInfo[];
  error?: string;
}

export interface HealthResult {
  status: string;
  sandboxId: string;
  uptimeMs: number;
  backendKind: string;
  error?: string;
}

export interface SandboxCapabilities {
  languages: string[];
  supportsCommands: boolean;
  supportsGit: boolean;
  supportsPreviewUrl: boolean;
  supportsStreaming: boolean;
  supportsSnapshots: boolean;
  hasNetworkAccess: boolean;
}

// ── Native binding loader ──────────────────────────────────────

let _native: any = null;

function loadNative() {
  if (_native) return _native;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const require = createRequire(import.meta.url);

  const paths = [
    join(__dirname, '../../native/agnt5-sdk-native.darwin-arm64.node'),
    join(__dirname, '../native/agnt5-sdk-native.darwin-arm64.node'),
    join(__dirname, '../../native/agnt5-sdk-native.linux-x64-gnu.node'),
    join(__dirname, '../native/agnt5-sdk-native.linux-x64-gnu.node'),
    join(__dirname, '../../native/agnt5-sdk-native.linux-x64.node'),
    join(__dirname, '../native/agnt5-sdk-native.linux-x64.node'),
  ];

  for (const p of paths) {
    try {
      _native = require(p);
      return _native;
    } catch {
      continue;
    }
  }

  throw new Error('Could not find native sandbox bindings');
}

// ── NAPI → TS field mapping helpers ────────────────────────────

function mapExecuteResult(r: any): ExecuteCodeResult {
  return {
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.exit_code ?? r.exitCode,
    executionTimeMs: r.execution_time_ms ?? r.executionTimeMs,
    error: r.error ?? undefined,
  };
}

function mapWriteResult(r: any): WriteFileResult {
  return {
    success: r.success,
    path: r.path,
    size: r.size,
    error: r.error ?? undefined,
  };
}

function mapReadResult(r: any): ReadFileResult {
  return {
    path: r.path,
    content: r.content,
    size: r.size,
    isDir: r.is_dir ?? r.isDir,
    error: r.error ?? undefined,
  };
}

function mapFileInfo(f: any): FileInfo {
  return {
    name: f.name,
    path: f.path,
    size: f.size,
    isDir: f.is_dir ?? f.isDir,
    mode: f.mode,
    modTime: f.mod_time ?? f.modTime,
  };
}

function mapListResult(r: any): ListFilesResult {
  return {
    path: r.path,
    total: r.total,
    files: (r.files ?? []).map(mapFileInfo),
    error: r.error ?? undefined,
  };
}

function mapHealthResult(r: any): HealthResult {
  return {
    status: r.status,
    sandboxId: r.sandbox_id ?? r.sandboxId,
    uptimeMs: r.uptime_ms ?? r.uptimeMs,
    backendKind: r.backend_kind ?? r.backendKind,
    error: r.error ?? undefined,
  };
}

function mapCapabilities(c: any): SandboxCapabilities {
  return {
    languages: c.languages,
    supportsCommands: c.supports_commands ?? c.supportsCommands,
    supportsGit: c.supports_git ?? c.supportsGit,
    supportsPreviewUrl: c.supports_preview_url ?? c.supportsPreviewUrl,
    supportsStreaming: c.supports_streaming ?? c.supportsStreaming,
    supportsSnapshots: c.supports_snapshots ?? c.supportsSnapshots,
    hasNetworkAccess: c.has_network_access ?? c.hasNetworkAccess,
  };
}

// ── Sandbox class ──────────────────────────────────────────────

/**
 * Deterministic sandbox workspace for tests and local examples.
 *
 * This backend exercises the public sandbox file API without a provider,
 * remote endpoint, or QuickJS binary. Its execute methods are deterministic
 * echoes; use {@link Sandbox} for real isolated code execution.
 */
export class InMemorySandbox {
  private readonly files = new Map<string, Buffer>();

  constructor(readonly sandboxId = 'memory') {}

  get backend(): string {
    return 'memory';
  }

  async start(): Promise<this> {
    return this;
  }

  async close(): Promise<void> {}

  async executeCode(code: string, language = 'javascript'): Promise<ExecuteCodeResult> {
    return {
      stdout: `[${language}] ${code}`,
      stderr: '',
      exitCode: 0,
      executionTimeMs: 0,
    };
  }

  async writeFile(path: string, content: Buffer | string): Promise<WriteFileResult> {
    const encoded = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
    this.files.set(path, encoded);
    return { success: true, path, size: encoded.length };
  }

  async readFile(path: string): Promise<ReadFileResult> {
    const content = this.files.get(path);
    if (!content) {
      throw new Error(`sandbox file not found: ${path}`);
    }
    return {
      path,
      content: Buffer.from(content),
      size: content.length,
      isDir: false,
    };
  }

  async deleteFile(path: string, recursive = false): Promise<boolean> {
    if (this.files.delete(path)) {
      return true;
    }
    if (!recursive) {
      return false;
    }
    const prefix = `${path.replace(/\/$/, '')}/`;
    const matches = [...this.files.keys()].filter((filePath) => filePath.startsWith(prefix));
    for (const filePath of matches) {
      this.files.delete(filePath);
    }
    return matches.length > 0;
  }

  async listFiles(path = '.', recursive = false): Promise<ListFilesResult> {
    const prefix = path === '' || path === '.' ? '' : `${path.replace(/\/$/, '')}/`;
    const files = [...this.files.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .filter(([filePath]) => !prefix || filePath.startsWith(prefix))
      .filter(([filePath]) => {
        const relative = prefix ? filePath.slice(prefix.length) : filePath.replace(/^\//, '');
        return recursive || !relative.includes('/');
      })
      .map(([filePath, content]): FileInfo => ({
        name: filePath.replace(/\/$/, '').split('/').at(-1) ?? filePath,
        path: filePath,
        size: content.length,
        isDir: false,
        mode: 0o644,
        modTime: 0,
      }));
    return { path, total: files.length, files };
  }

  async health(): Promise<HealthResult> {
    return {
      status: 'running',
      sandboxId: this.sandboxId,
      uptimeMs: 0,
      backendKind: this.backend,
    };
  }

  capabilities(): SandboxCapabilities {
    return {
      languages: [],
      supportsCommands: false,
      supportsGit: false,
      supportsPreviewUrl: false,
      supportsStreaming: false,
      supportsSnapshots: false,
      hasNetworkAccess: false,
    };
  }
}

export class Sandbox {
  private inner: any | null = null;
  private providerName?: string;
  private providerClient?: SandboxProvider;
  private providerSandbox?: any;
  private readonly autoDestroy: boolean;
  private readonly createOptions: CreateSandboxOptions;

  constructor(options?: SandboxOptions) {
    this.autoDestroy = options?.autoDestroy ?? true;
    this.createOptions = {
      template: options?.template,
      timeoutSecs: options?.timeoutSecs,
      env: options?.env,
      metadata: options?.metadata,
      cpuCores: options?.cpuCores,
      memoryMib: options?.memoryMib,
    };

    if (!options || options.provider) {
      this.providerName = options?.provider ?? 'auto';
      return;
    }

    const native = loadNative();
    const nativeOpts = options
      ? {
          backend: options.backend,
          endpoint: options.endpoint ?? process.env.AGNT5_SANDBOX_ENDPOINT,
          sandbox_id: options.sandboxId,
          api_key: options.apiKey,
          bearer_token: options.bearerToken,
          timeout_secs: options.timeoutSecs,
          quickjs_wasm_path: options.quickjsWasmPath,
        }
      : undefined;
    this.inner = new native.Sandbox(nativeOpts);
  }

  /** Active backend type ("remote" or "wasm"). */
  get backend(): string {
    if (this.providerName) return `provider:${this.providerName}`;
    if (!this.inner) throw new Error('Sandbox is not initialized');
    return this.inner.backend;
  }

  /** Create the provider sandbox if this is provider-backed. */
  async start(): Promise<this> {
    await this.ensureProviderSandbox();
    return this;
  }

  /** Destroy provider sandbox resources owned by this wrapper. */
  async close(): Promise<void> {
    if (this.providerSandbox) {
      const sandboxId = this.providerSandbox.sandboxId;
      if (this.autoDestroy && this.providerClient && sandboxId) {
        await this.providerClient.destroy(sandboxId);
      }
      this.providerSandbox = undefined;
    }
  }

  private async ensureProviderSandbox(): Promise<any | undefined> {
    if (!this.providerName) return undefined;
    if (this.providerSandbox) return this.providerSandbox;

    const providers = loadProvidersFromEnv();
    let name: string | undefined = this.providerName;
    if (name === 'auto') {
      name = Object.keys(providers)[0];
    }
    if (!name || !(name in providers)) {
      const available = Object.keys(providers).sort().join(', ') || 'none';
      throw new Error(
        `Sandbox provider '${this.providerName}' is not configured. Available providers from environment: ${available}.`
      );
    }

    this.providerName = name;
    this.providerClient = providers[name];
    this.providerSandbox = await this.providerClient.create(this.createOptions);
    return this.providerSandbox;
  }

  /** Execute code in a sandboxed environment. */
  async executeCode(
    code: string,
    language?: string,
    timeoutMs?: number,
  ): Promise<ExecuteCodeResult> {
    const providerSandbox = await this.ensureProviderSandbox();
    if (providerSandbox) {
      return providerSandbox.executeCode(code, language, { timeoutMs });
    }
    if (!this.inner) throw new Error('Sandbox is not initialized');
    const r = await this.inner.executeCode(code, language, timeoutMs);
    return mapExecuteResult(r);
  }

  /** Write a file into the sandbox workspace. */
  async writeFile(path: string, content: Buffer | string): Promise<WriteFileResult> {
    const providerSandbox = await this.ensureProviderSandbox();
    if (providerSandbox) {
      return providerSandbox.writeFile(path, content);
    }
    if (!this.inner) throw new Error('Sandbox is not initialized');
    const buf = typeof content === 'string' ? Buffer.from(content) : content;
    const r = await this.inner.writeFile(path, buf);
    return mapWriteResult(r);
  }

  /** Read a file from the sandbox workspace. */
  async readFile(path: string): Promise<ReadFileResult> {
    const providerSandbox = await this.ensureProviderSandbox();
    if (providerSandbox) {
      return providerSandbox.readFile(path);
    }
    if (!this.inner) throw new Error('Sandbox is not initialized');
    const r = await this.inner.readFile(path);
    return mapReadResult(r);
  }

  /** Delete a file or directory from the sandbox workspace. */
  async deleteFile(path: string, recursive?: boolean): Promise<boolean> {
    const providerSandbox = await this.ensureProviderSandbox();
    if (providerSandbox) {
      return providerSandbox.deleteFile(path, recursive);
    }
    if (!this.inner) throw new Error('Sandbox is not initialized');
    return this.inner.deleteFile(path, recursive);
  }

  /** List files in the sandbox workspace. */
  async listFiles(path?: string, recursive?: boolean): Promise<ListFilesResult> {
    const providerSandbox = await this.ensureProviderSandbox();
    if (providerSandbox) {
      return providerSandbox.listFiles(path ?? '.', recursive);
    }
    if (!this.inner) throw new Error('Sandbox is not initialized');
    const r = await this.inner.listFiles(path, recursive);
    return mapListResult(r);
  }

  /** Check sandbox health and status. */
  async health(): Promise<HealthResult> {
    const providerSandbox = await this.ensureProviderSandbox();
    if (providerSandbox) {
      return {
        status: 'running',
        sandboxId: providerSandbox.sandboxId ?? '',
        uptimeMs: 0,
        backendKind: this.backend,
      };
    }
    if (!this.inner) throw new Error('Sandbox is not initialized');
    const r = await this.inner.health();
    return mapHealthResult(r);
  }

  /** Query sandbox capabilities (languages, features). */
  capabilities(): SandboxCapabilities {
    if (this.providerName) {
      return {
        languages: ['python', 'javascript', 'bash'],
        supportsCommands: true,
        supportsGit: false,
        supportsPreviewUrl: true,
        supportsStreaming: false,
        supportsSnapshots: false,
        hasNetworkAccess: true,
      };
    }
    if (!this.inner) throw new Error('Sandbox is not initialized');
    return mapCapabilities(this.inner.capabilities());
  }
}
