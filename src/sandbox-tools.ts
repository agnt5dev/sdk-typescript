/**
 * Pre-built sandbox tools for Agent use.
 *
 * Prefer passing `sandbox: new Sandbox({ provider: 'e2b' })` to `Agent`.
 * This helper remains useful for advanced manual tool composition.
 */

import { Tool } from './tool.js';
import type { Context } from './types.js';
import type { Sandbox } from './sandbox.js';

export interface SandboxToolsOptions {
  sandbox?: Sandbox;
}

function getSandbox(ctx: Context, sandbox?: Sandbox): Sandbox {
  const active = sandbox ?? (ctx as any).sandbox;
  if (!active) {
    throw new Error(
      'No sandbox available. Pass sandbox to sandboxTools(), or construct Agent with sandbox.'
    );
  }
  return active;
}

export function sandboxTools(options: SandboxToolsOptions = {}): Tool[] {
  const sandbox = options.sandbox;

  return [
    new Tool(
      'sandbox_execute_code',
      'Execute code in a sandboxed environment. Returns stdout, stderr, and exit code.',
      async (ctx: Context, args: Record<string, any>) => {
        const result = await getSandbox(ctx, sandbox).executeCode(
          args.code,
          args.language ?? 'python',
          args.timeoutMs ?? args.timeout_ms,
        );
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.exitCode,
          execution_time_ms: result.executionTimeMs,
          error: result.error,
        };
      },
      {
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Source code to execute.' },
            language: {
              type: 'string',
              description: 'Programming language: python, javascript, or bash.',
            },
            timeoutMs: { type: 'integer', description: 'Execution timeout in milliseconds.' },
          },
          required: ['code'],
        },
      },
    ),
    new Tool(
      'sandbox_write_file',
      'Write content to a file in the sandbox workspace.',
      async (ctx: Context, args: Record<string, any>) => {
        const result = await getSandbox(ctx, sandbox).writeFile(args.path, args.content);
        return {
          success: result.success,
          path: result.path,
          size: result.size,
          error: result.error,
        };
      },
      {
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to write.' },
            content: { type: 'string', description: 'Text content to write.' },
          },
          required: ['path', 'content'],
        },
      },
    ),
    new Tool(
      'sandbox_read_file',
      'Read the contents of a file from the sandbox workspace.',
      async (ctx: Context, args: Record<string, any>) => {
        const result = await getSandbox(ctx, sandbox).readFile(args.path);
        return {
          path: result.path,
          content: result.content.toString('utf-8'),
          size: result.size,
          is_dir: result.isDir,
          error: result.error,
        };
      },
      {
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to read.' },
          },
          required: ['path'],
        },
      },
    ),
    new Tool(
      'sandbox_list_files',
      'List files and directories in the sandbox workspace.',
      async (ctx: Context, args: Record<string, any>) => {
        const result = await getSandbox(ctx, sandbox).listFiles(args.path ?? '.', args.recursive ?? false);
        return {
          path: result.path,
          total: result.total,
          files: result.files.map(file => ({
            name: file.name,
            path: file.path,
            size: file.size,
            is_dir: file.isDir,
            mode: file.mode,
            mod_time: file.modTime,
          })),
          error: result.error,
        };
      },
      {
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path to list.' },
            recursive: { type: 'boolean', description: 'Whether to list recursively.' },
          },
          required: [],
        },
      },
    ),
  ];
}
