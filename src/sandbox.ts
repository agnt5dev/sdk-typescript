/**
 * Sandbox — secure code execution and file I/O.
 *
 * Wraps the native Rust sandbox bindings, supporting both remote (HTTP)
 * and embedded (WASM) backends. The backend is selected automatically
 * based on available configuration.
 *
 * @example
 * ```ts
 * import { Sandbox } from '@agnt5/sdk';
 *
 * const sandbox = new Sandbox({ endpoint: 'http://localhost:8080' });
 * const result = await sandbox.executeCode('console.log("hello")', 'javascript');
 * console.log(result.stdout); // "hello"
 * ```
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Types ──────────────────────────────────────────────────────

export interface SandboxOptions {
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
  /** Request timeout in seconds (default: 300). */
  timeoutSecs?: number;
  /** Path to QuickJS WASI binary (for wasm backend). */
  quickjsWasmPath?: string;
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

export class Sandbox {
  private inner: any;

  constructor(options?: SandboxOptions) {
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
    return this.inner.backend;
  }

  /** Execute code in a sandboxed environment. */
  async executeCode(
    code: string,
    language?: string,
    timeoutMs?: number,
  ): Promise<ExecuteCodeResult> {
    const r = await this.inner.executeCode(code, language, timeoutMs);
    return mapExecuteResult(r);
  }

  /** Write a file into the sandbox workspace. */
  async writeFile(path: string, content: Buffer | string): Promise<WriteFileResult> {
    const buf = typeof content === 'string' ? Buffer.from(content) : content;
    const r = await this.inner.writeFile(path, buf);
    return mapWriteResult(r);
  }

  /** Read a file from the sandbox workspace. */
  async readFile(path: string): Promise<ReadFileResult> {
    const r = await this.inner.readFile(path);
    return mapReadResult(r);
  }

  /** Delete a file or directory from the sandbox workspace. */
  async deleteFile(path: string, recursive?: boolean): Promise<boolean> {
    return this.inner.deleteFile(path, recursive);
  }

  /** List files in the sandbox workspace. */
  async listFiles(path?: string, recursive?: boolean): Promise<ListFilesResult> {
    const r = await this.inner.listFiles(path, recursive);
    return mapListResult(r);
  }

  /** Check sandbox health and status. */
  async health(): Promise<HealthResult> {
    const r = await this.inner.health();
    return mapHealthResult(r);
  }

  /** Query sandbox capabilities (languages, features). */
  capabilities(): SandboxCapabilities {
    return mapCapabilities(this.inner.capabilities());
  }
}
