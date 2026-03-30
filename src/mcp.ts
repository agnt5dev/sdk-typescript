/**
 * MCP (Model Context Protocol) client for connecting to external tool servers.
 *
 * Supports Stdio transport with JSON-RPC 2.0.
 * SSE transport is defined but requires an HTTP client (e.g., undici).
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { Tool } from './tool.js';
import type { Context } from './types.js';

// ─── Types ───────────────────────────────────────────────────────────

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

export interface McpToolWithServer {
  server: string;
  tool: McpTool;
}

export interface ToolContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface CallToolResult {
  content: ToolContent[];
  isError: boolean;
}

export interface StdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface SseConfig {
  url: string;
  headers?: Record<string, string>;
}

export type TransportType = 'stdio' | 'sse';

export interface ServerConfig {
  transportType: TransportType;
  stdio?: StdioConfig;
  sse?: SseConfig;
}

export class MCPError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MCPError';
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function parseServerConfig(config: Record<string, any>): ServerConfig {
  if (config.command) {
    return {
      transportType: 'stdio',
      stdio: {
        command: config.command,
        args: config.args || [],
        env: config.env,
        cwd: config.cwd,
      },
    };
  }
  if (config.url) {
    return {
      transportType: 'sse',
      sse: {
        url: config.url,
        headers: config.headers,
      },
    };
  }
  throw new MCPError('Invalid server config: must have "command" (stdio) or "url" (sse)');
}

function getText(result: CallToolResult): string {
  return result.content
    .filter(c => c.type === 'text' && c.text)
    .map(c => c.text!)
    .join('');
}

// ─── Transport ───────────────────────────────────────────────────────

interface Transport {
  request(method: string, params: Record<string, any>): Promise<Record<string, any>>;
  notify(method: string, params: Record<string, any>): Promise<void>;
  close(): Promise<void>;
  readonly isConnected: boolean;
}

/**
 * Stdio transport using Content-Length framed JSON-RPC over subprocess pipes.
 */
class StdioTransport implements Transport {
  private process: ChildProcess;
  private _connected = false;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = '';

  private constructor(proc: ChildProcess) {
    this.process = proc;
  }

  static async create(config: StdioConfig): Promise<StdioTransport> {
    const env = { ...process.env, ...(config.env || {}) };
    const proc = spawn(config.command, config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: config.cwd,
    });

    const transport = new StdioTransport(proc);
    transport._connected = true;

    proc.stdout!.on('data', (chunk: Buffer) => {
      transport.buffer += chunk.toString('utf-8');
      transport.processBuffer();
    });

    proc.on('exit', () => {
      transport._connected = false;
      // Reject all pending requests
      for (const [, p] of transport.pending) {
        p.reject(new MCPError('MCP server process exited'));
      }
      transport.pending.clear();
    });

    return transport;
  }

  get isConnected(): boolean {
    return this._connected;
  }

  private processBuffer(): void {
    // Content-Length framed messages
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.buffer.substring(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Try plain JSON (no Content-Length framing)
        const newlineIdx = this.buffer.indexOf('\n');
        if (newlineIdx === -1) break;
        const line = this.buffer.substring(0, newlineIdx).trim();
        this.buffer = this.buffer.substring(newlineIdx + 1);
        if (line) {
          try {
            const msg = JSON.parse(line);
            this.handleMessage(msg);
          } catch { /* skip */ }
        }
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) break;

      const body = this.buffer.substring(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.substring(bodyStart + contentLength);

      try {
        const msg = JSON.parse(body);
        this.handleMessage(msg);
      } catch { /* skip malformed */ }
    }
  }

  private handleMessage(msg: any): void {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new MCPError(msg.error.message || JSON.stringify(msg.error)));
      } else {
        p.resolve(msg.result || {});
      }
    }
  }

  private send(data: Record<string, any>): void {
    const json = JSON.stringify(data);
    const msg = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
    this.process.stdin!.write(msg);
  }

  async request(method: string, params: Record<string, any>): Promise<Record<string, any>> {
    const id = this.nextId++;
    const data = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new MCPError(`MCP request timed out: ${method}`));
      }, 30000);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });

      this.send(data);
    });
  }

  async notify(method: string, params: Record<string, any>): Promise<void> {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async close(): Promise<void> {
    this._connected = false;
    this.process.kill();
    for (const [, p] of this.pending) {
      p.reject(new MCPError('Transport closed'));
    }
    this.pending.clear();
  }
}

/**
 * SSE transport using HTTP POST for requests and Server-Sent Events for responses.
 *
 * Protocol:
 * 1. GET to server URL with Accept: text/event-stream to open SSE stream
 * 2. SSE stream delivers JSON-RPC responses and session IDs
 * 3. POST JSON-RPC requests to server URL (with session query param if available)
 * 4. Responses arrive either in POST response body or via SSE stream
 */
class SseTransport implements Transport {
  private _connected = false;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private sessionId: string | null = null;
  private abortController: AbortController | null = null;
  private url: string;
  private headers: Record<string, string>;

  private constructor(url: string, headers: Record<string, string>) {
    this.url = url;
    this.headers = headers;
  }

  static async create(config: SseConfig): Promise<SseTransport> {
    const transport = new SseTransport(config.url, config.headers || {});
    await transport.connect();
    return transport;
  }

  get isConnected(): boolean {
    return this._connected;
  }

  private async connect(): Promise<void> {
    this.abortController = new AbortController();

    const response = await fetch(this.url, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        ...this.headers,
      },
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      throw new MCPError(`SSE connection failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new MCPError('SSE response has no body');
    }

    this._connected = true;

    // Start background SSE reader
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const readLoop = async () => {
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE lines
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue; // Skip empty lines and comments

            if (trimmed.startsWith('data: ')) {
              const data = trimmed.slice(6);
              try {
                const value = JSON.parse(data);

                // Check for session ID
                if (value.session && typeof value.session === 'string') {
                  this.sessionId = value.session;
                }

                // Check for JSON-RPC response (has id field)
                if (value.id !== undefined && this.pending.has(value.id)) {
                  const p = this.pending.get(value.id)!;
                  this.pending.delete(value.id);
                  if (value.error) {
                    p.reject(new MCPError(value.error.message || JSON.stringify(value.error)));
                  } else {
                    p.resolve(value.result || {});
                  }
                }
              } catch {
                // Skip non-JSON data lines
              }
            }
          }
        }
      } catch (e: any) {
        if (e.name !== 'AbortError') {
          this._connected = false;
        }
      }
    };

    // Don't await — run in background
    readLoop().catch(() => { this._connected = false; });
  }

  async request(method: string, params: Record<string, any>): Promise<Record<string, any>> {
    if (!this._connected) {
      throw new MCPError('SSE transport not connected');
    }

    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    // Build URL with session if available
    let url = this.url;
    if (this.sessionId) {
      url += (url.includes('?') ? '&' : '?') + `session=${this.sessionId}`;
    }

    // Create pending promise for SSE-delivered response
    const responsePromise = new Promise<Record<string, any>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new MCPError(`MCP SSE request timed out: ${method}`));
      }, 30000);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });
    });

    // POST the request
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body,
    });

    if (!response.ok) {
      this.pending.delete(id);
      throw new MCPError(`SSE request failed: ${response.status} ${response.statusText}`);
    }

    // Try to get response from POST body first (stateless endpoints)
    const responseBody = await response.text();
    if (responseBody) {
      try {
        const rpcResponse = JSON.parse(responseBody);
        if (rpcResponse.id === id) {
          this.pending.delete(id);
          if (rpcResponse.error) {
            throw new MCPError(rpcResponse.error.message || JSON.stringify(rpcResponse.error));
          }
          return rpcResponse.result || {};
        }
      } catch (e) {
        if (e instanceof MCPError) throw e;
        // Not valid JSON or different ID — wait for SSE
      }
    }

    // Wait for response via SSE stream
    return responsePromise;
  }

  async notify(method: string, params: Record<string, any>): Promise<void> {
    if (!this._connected) {
      throw new MCPError('SSE transport not connected');
    }

    const body = JSON.stringify({ jsonrpc: '2.0', method, params });

    let url = this.url;
    if (this.sessionId) {
      url += (url.includes('?') ? '&' : '?') + `session=${this.sessionId}`;
    }

    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body,
    });
  }

  async close(): Promise<void> {
    this._connected = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    for (const [, p] of this.pending) {
      p.reject(new MCPError('Transport closed'));
    }
    this.pending.clear();
  }
}

// ─── Types ──────────────────────────────────────────────────────────

export interface ServerCapabilities {
  tools?: boolean;
  resources?: boolean;
  prompts?: boolean;
}

export interface ServerInfo {
  name: string;
  version: string;
}

// ─── MCPClient ───────────────────────────────────────────────────────

/**
 * MCP client for connecting to one or more MCP tool servers.
 *
 * @example
 * ```typescript
 * const mcp = new MCPClient('my-tools', {
 *   wikipedia: { command: 'npx', args: ['-y', 'wikipedia-mcp'] },
 * });
 *
 * await mcp.connect();
 * const tools = mcp.getTools();
 * const agent = new Agent({ name: 'researcher', model, tools, instructions: '...' });
 *
 * await mcp.disconnect();
 * ```
 */
export class MCPClient {
  private _id: string;
  private _configs: Map<string, ServerConfig> = new Map();
  private _transports: Map<string, Transport> = new Map();
  private _tools: Map<string, McpTool[]> = new Map();

  constructor(id: string, servers?: Record<string, Record<string, any>>) {
    this._id = id;
    if (servers) {
      for (const [name, config] of Object.entries(servers)) {
        this._configs.set(name, parseServerConfig(config));
      }
    }
  }

  get id(): string {
    return this._id;
  }

  /** Add a server configuration */
  addServer(name: string, config: Record<string, any> | ServerConfig): void {
    if ('transportType' in config) {
      this._configs.set(name, config as ServerConfig);
    } else {
      this._configs.set(name, parseServerConfig(config));
    }
  }

  /** Add a stdio server (convenience) */
  addStdioServer(
    name: string,
    command: string,
    args?: string[],
    env?: Record<string, string>,
    cwd?: string,
  ): void {
    this._configs.set(name, {
      transportType: 'stdio',
      stdio: { command, args, env, cwd },
    });
  }

  /** Add an SSE server (convenience) */
  addSseServer(name: string, url: string, headers?: Record<string, string>): void {
    this._configs.set(name, {
      transportType: 'sse',
      sse: { url, headers },
    });
  }

  /** Connect to all configured servers */
  async connect(): Promise<void> {
    for (const [name, config] of this._configs) {
      await this.connectServer(name, config);
    }
  }

  private async connectServer(name: string, config: ServerConfig): Promise<void> {
    let transport: Transport;

    if (config.transportType === 'stdio' && config.stdio) {
      transport = await StdioTransport.create(config.stdio);
    } else if (config.transportType === 'sse' && config.sse) {
      transport = await SseTransport.create(config.sse);
    } else {
      throw new MCPError(`Unknown transport type: ${config.transportType}`);
    }

    this._transports.set(name, transport);

    // Initialize MCP protocol
    const initResult = await transport.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: this._id, version: '1.0.0' },
    });

    // Send initialized notification
    await transport.notify('notifications/initialized', {});

    // Discover tools
    const capabilities = initResult.capabilities || {};
    if (capabilities.tools) {
      const toolsResult = await transport.request('tools/list', {});
      const tools: McpTool[] = (toolsResult.tools || []).map((t: any) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      this._tools.set(name, tools);
    } else {
      this._tools.set(name, []);
    }
  }

  /** Disconnect from all servers */
  async disconnect(): Promise<void> {
    for (const [, transport] of this._transports) {
      await transport.close();
    }
    this._transports.clear();
    this._tools.clear();
  }

  /** List all tools from all connected servers */
  listTools(): McpToolWithServer[] {
    const result: McpToolWithServer[] = [];
    for (const [server, tools] of this._tools) {
      for (const tool of tools) {
        result.push({ server, tool });
      }
    }
    return result;
  }

  /** List tools from a specific server */
  listServerTools(server: string): McpTool[] {
    const tools = this._tools.get(server);
    if (!tools) throw new MCPError(`Server '${server}' not connected`);
    return [...tools];
  }

  /** Call a tool on a specific server */
  async callTool(
    server: string,
    toolName: string,
    args?: Record<string, any>,
  ): Promise<CallToolResult> {
    const transport = this._transports.get(server);
    if (!transport) throw new MCPError(`Server '${server}' not connected`);

    const result = await transport.request('tools/call', {
      name: toolName,
      arguments: args || {},
    });

    return {
      content: (result.content || []).map((c: any) => ({
        type: c.type || 'text',
        text: c.text,
        data: c.data,
        mimeType: c.mimeType,
      })),
      isError: result.isError || false,
    };
  }

  /** Call a tool by name across all connected servers */
  async callToolAuto(toolName: string, args?: Record<string, any>): Promise<CallToolResult> {
    for (const [server, tools] of this._tools) {
      if (tools.some(t => t.name === toolName)) {
        return this.callTool(server, toolName, args);
      }
    }
    throw new MCPError(`Tool '${toolName}' not found in any connected server`);
  }

  /**
   * Get MCP tools as AGNT5 Tool objects for use with Agent.
   *
   * @example
   * ```typescript
   * const tools = mcp.getTools();
   * const agent = new Agent({ name: 'helper', model, tools, instructions: '...' });
   * ```
   */
  getTools(): Tool[] {
    const agnt5Tools: Tool[] = [];

    for (const [server, tools] of this._tools) {
      for (const mcpTool of tools) {
        const serverName = server;
        const toolName = mcpTool.name;

        const agnt5Tool = new Tool(
          mcpTool.name,
          mcpTool.description || mcpTool.name,
          async (_ctx: Context, args: Record<string, any>) => {
            const result = await this.callTool(serverName, toolName, args);
            return getText(result);
          },
          { inputSchema: mcpTool.inputSchema },
        );

        agnt5Tools.push(agnt5Tool);
      }
    }

    return agnt5Tools;
  }

  /** Check if a server is connected */
  isConnected(server: string): boolean {
    const transport = this._transports.get(server);
    return transport?.isConnected || false;
  }

  /** Get list of connected server names */
  connectedServers(): string[] {
    return Array.from(this._transports.keys()).filter(s => this.isConnected(s));
  }
}
