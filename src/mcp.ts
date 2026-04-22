import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Tool } from './tool.js';
import type { Context } from './types.js';

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

export interface ServerCapabilities {
  tools?: boolean;
  resources?: boolean;
  prompts?: boolean;
}

export interface ServerInfo {
  name: string;
  version: string;
}

export class MCPError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MCPError';
  }
}

let nativeBindings: any = null;

function loadNativeBindings() {
  if (nativeBindings) return nativeBindings;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const require = createRequire(import.meta.url);

  const possiblePaths = [
    join(__dirname, '../../native/agnt5-sdk-native.darwin-arm64.node'),
    join(__dirname, '../native/agnt5-sdk-native.darwin-arm64.node'),
    join(__dirname, '../../native/agnt5-sdk-native.linux-x64-gnu.node'),
    join(__dirname, '../native/agnt5-sdk-native.linux-x64-gnu.node'),
    join(__dirname, '../../native/agnt5-sdk-native.linux-x64.node'),
    join(__dirname, '../native/agnt5-sdk-native.linux-x64.node'),
  ];

  for (const nativePath of possiblePaths) {
    try {
      nativeBindings = require(nativePath);
      return nativeBindings;
    } catch {
      continue;
    }
  }

  throw new Error('Could not find native MCP bindings');
}

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

function normalizeTool(tool: any): McpTool {
  return {
    name: tool.name,
    description: tool.description ?? undefined,
    inputSchema: tool.inputSchema ?? undefined,
  };
}

function normalizeCallToolResult(result: any): CallToolResult {
  return {
    content: (result.content || []).map((item: any) => ({
      type: item.type || 'text',
      text: item.text,
      data: item.data,
      mimeType: item.mimeType,
    })),
    isError: Boolean(result.isError),
  };
}

/**
 * Native-backed MCP client facade for TypeScript.
 */
export class MCPClient {
  private _id: string;
  private _configs: Map<string, ServerConfig> = new Map();
  private _connectedServers: Set<string> = new Set();
  private _tools: Map<string, McpTool[]> = new Map();
  private _core: any;

  constructor(id: string, servers?: Record<string, Record<string, any>>) {
    this._id = id;
    const bindings = loadNativeBindings();
    if (!bindings.MCPClientCore) {
      throw new Error('Native MCP bindings are not available');
    }
    this._core = new bindings.MCPClientCore(id);

    if (servers) {
      for (const [name, config] of Object.entries(servers)) {
        this.addServer(name, config);
      }
    }
  }

  get id(): string {
    return this._id;
  }

  addServer(name: string, config: Record<string, any> | ServerConfig): void {
    const parsed = 'transportType' in config ? config as ServerConfig : parseServerConfig(config);
    this._configs.set(name, parsed);

    if (parsed.transportType === 'stdio' && parsed.stdio) {
      this._core.addStdioServer(
        name,
        parsed.stdio.command,
        parsed.stdio.args ?? [],
        parsed.stdio.env ?? {},
        parsed.stdio.cwd ?? undefined,
      );
      return;
    }

    if (parsed.transportType === 'sse' && parsed.sse) {
      this._core.addSseServer(
        name,
        parsed.sse.url,
        parsed.sse.headers ?? {},
        undefined,
      );
      return;
    }

    throw new MCPError(`Unknown transport type: ${parsed.transportType}`);
  }

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
    this._core.addStdioServer(name, command, args ?? [], env ?? {}, cwd ?? undefined);
  }

  addSseServer(name: string, url: string, headers?: Record<string, string>): void {
    this._configs.set(name, {
      transportType: 'sse',
      sse: { url, headers },
    });
    this._core.addSseServer(name, url, headers ?? {}, undefined);
  }

  async connect(): Promise<void> {
    try {
      await this._core.connect();
      this._connectedServers = new Set(this._configs.keys());
      const tools = JSON.parse(await this._core.listToolsJson()) as Array<{ server: string; tool: any }>;
      this._tools.clear();
      for (const item of tools) {
        const toolsForServer = this._tools.get(item.server) ?? [];
        toolsForServer.push(normalizeTool(item.tool));
        this._tools.set(item.server, toolsForServer);
      }
    } catch (error: any) {
      throw new MCPError(error?.message || String(error));
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this._core.disconnect();
    } catch (error: any) {
      throw new MCPError(error?.message || String(error));
    } finally {
      this._connectedServers.clear();
      this._tools.clear();
    }
  }

  listTools(): McpToolWithServer[] {
    const result: McpToolWithServer[] = [];
    for (const [server, tools] of this._tools) {
      for (const tool of tools) {
        result.push({ server, tool });
      }
    }
    return result;
  }

  listServerTools(server: string): McpTool[] {
    const tools = this._tools.get(server);
    if (!tools) throw new MCPError(`Server '${server}' not connected`);
    return [...tools];
  }

  async callTool(
    server: string,
    toolName: string,
    args?: Record<string, any>,
  ): Promise<CallToolResult> {
    if (!this._connectedServers.has(server)) {
      throw new MCPError(`Server '${server}' not connected`);
    }

    try {
      const result = JSON.parse(
        await this._core.callToolJson(server, toolName, JSON.stringify(args || {})),
      );
      return normalizeCallToolResult(result);
    } catch (error: any) {
      throw new MCPError(error?.message || String(error));
    }
  }

  async callToolAuto(toolName: string, args?: Record<string, any>): Promise<CallToolResult> {
    for (const tools of this._tools.values()) {
      if (tools.some(t => t.name === toolName)) {
        try {
          const result = JSON.parse(
            await this._core.callToolAutoJson(toolName, JSON.stringify(args || {})),
          );
          return normalizeCallToolResult(result);
        } catch (error: any) {
          throw new MCPError(error?.message || String(error));
        }
      }
    }
    throw new MCPError(`Tool '${toolName}' not found in any connected server`);
  }

  getTools(): Tool[] {
    const agnt5Tools: Tool[] = [];

    for (const [server, tools] of this._tools) {
      for (const mcpTool of tools) {
        const serverName = server;
        const toolName = mcpTool.name;

        agnt5Tools.push(
          new Tool(
            mcpTool.name,
            mcpTool.description || mcpTool.name,
            async (_ctx: Context, args: Record<string, any>) => {
              const result = await this.callTool(serverName, toolName, args);
              return getText(result);
            },
            { inputSchema: mcpTool.inputSchema },
          ),
        );
      }
    }

    return agnt5Tools;
  }

  isConnected(server: string): boolean {
    return this._connectedServers.has(server);
  }

  connectedServers(): string[] {
    return Array.from(this._connectedServers).sort();
  }
}
