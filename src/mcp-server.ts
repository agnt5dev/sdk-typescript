import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';

import { ContextImpl } from './context.js';
import type { JSONSchema } from './types.js';
import { Tool } from './tool.js';
import { Agent } from './agent.js';

export class MCPServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MCPServerError';
  }
}

export interface PromptMessage {
  role: string;
  content: {
    type: string;
    text?: string;
    [key: string]: any;
  };
}

export interface PromptOptions {
  name: string;
  description?: string;
  argumentsSchema?: JSONSchema;
  handler: (args: Record<string, any>) => Promise<{ messages: PromptMessage[] } | PromptMessage[] | string | any>;
}

export class Prompt {
  readonly name: string;
  readonly description?: string;
  readonly argumentsSchema?: JSONSchema;
  readonly handler: PromptOptions['handler'];

  constructor(options: PromptOptions) {
    this.name = options.name;
    this.description = options.description;
    this.argumentsSchema = options.argumentsSchema;
    this.handler = options.handler;
  }
}

export interface ResourceOptions {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  read: () => Promise<any>;
}

export class Resource {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly read: () => Promise<any>;

  constructor(options: ResourceOptions) {
    this.uri = options.uri;
    this.name = options.name;
    this.description = options.description;
    this.mimeType = options.mimeType;
    this.read = options.read;
  }

  static text(options: ResourceOptions): Resource {
    return new Resource({
      ...options,
      mimeType: options.mimeType || 'text/plain',
    });
  }
}

export interface MCPServerOptions {
  id: string;
  name: string;
  version: string;
  tools?: Record<string, Tool>;
  agents?: Record<string, Agent>;
  workflows?: Record<string, any>;
  prompts?: Record<string, Prompt>;
  resources?: Record<string, Resource>;
  instructions?: string;
  metadata?: Record<string, any>;
}

interface MCPServerHandle {
  host: string;
  port: number;
  close(): Promise<void>;
  closed: Promise<void>;
}

export class MCPServer {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly instructions?: string;
  readonly metadata: Record<string, any>;

  private tools = new Map<string, Tool>();
  private agents = new Map<string, Agent>();
  private workflows = new Map<string, any>();
  private prompts = new Map<string, Prompt>();
  private resources = new Map<string, Resource>();

  constructor(options: MCPServerOptions) {
    this.id = options.id;
    this.name = options.name;
    this.version = options.version;
    this.instructions = options.instructions;
    this.metadata = options.metadata || {};

    for (const [name, tool] of Object.entries(options.tools || {})) {
      this.tools.set(name, tool);
    }
    for (const [name, agent] of Object.entries(options.agents || {})) {
      this.agents.set(name, agent);
    }
    for (const [name, workflow] of Object.entries(options.workflows || {})) {
      this.workflows.set(name, workflow);
    }
    for (const [name, prompt] of Object.entries(options.prompts || {})) {
      this.prompts.set(name, prompt);
    }
    for (const [name, resource] of Object.entries(options.resources || {})) {
      this.resources.set(name, resource);
    }
  }

  addTool(name: string, tool: Tool): void {
    this.tools.set(name, tool);
  }

  addAgent(name: string, agent: Agent): void {
    this.agents.set(name, agent);
  }

  addWorkflow(name: string, workflow: any): void {
    this.workflows.set(name, workflow);
  }

  addPrompt(name: string, prompt: Prompt): void {
    this.prompts.set(name, prompt);
  }

  addResource(name: string, resource: Resource): void {
    this.resources.set(name, resource);
  }

  async runStdio(): Promise<void> {
    const stdin = process.stdin;
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    for await (const chunk of stdin) {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const parsed = this.tryParseMessage(buffer);
        if (!parsed) break;
        buffer = parsed.remaining;
        const response = await this.dispatch(parsed.request);
        this.writeMessage(Buffer.from(JSON.stringify(response), 'utf8'));
      }
    }
  }

  async runHTTP(options?: { host?: string; port?: number; path?: string }): Promise<void> {
    const handle = await this.startHTTP(options);
    await handle.closed;
  }

  async dispatch(request: Record<string, any>): Promise<Record<string, any>> {
    try {
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        result: await this.handleRequest(request.method, request.params || {}),
      };
    } catch (error: any) {
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: {
          code: -32603,
          message: error?.message || String(error),
        },
      };
    }
  }

  private tryParseMessage(buffer: Buffer): { request: Record<string, any>; remaining: Buffer } | null {
    const lineEnd = buffer.indexOf('\n');
    if (lineEnd === -1) return null;

    const line = buffer.subarray(0, lineEnd).toString('utf8').replace(/\r$/, '');
    return {
      request: JSON.parse(line),
      remaining: Buffer.from(buffer.subarray(lineEnd + 1)),
    };
  }

  private writeMessage(payload: Buffer): void {
    process.stdout.write(payload);
    process.stdout.write('\n');
  }

  private async startHTTP(options?: { host?: string; port?: number; path?: string }): Promise<MCPServerHandle> {
    const host = options?.host || '127.0.0.1';
    const port = options?.port ?? 0;
    const path = this.normalizePath(options?.path || '/mcp');
    const server = createServer((req, res) => {
      this.handleStreamableHttpRequest(req, res, path).catch(error => {
        this.writeJson(res, 500, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: error?.message || String(error) },
        });
      });
    });

    return this.listen(server, host, port);
  }

  private async handleStreamableHttpRequest(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (!this.isAllowedOrigin(req.headers.origin, req.headers.host)) {
      this.writeText(res, 403, 'forbidden origin');
      return;
    }

    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== path) {
      this.writeText(res, 404, 'not found');
      return;
    }

    if (req.method === 'GET') {
      this.writeText(res, 405, 'GET stream is not supported');
      return;
    }
    if (req.method !== 'POST') {
      this.writeText(res, 405, 'method not allowed');
      return;
    }

    const request = JSON.parse(await this.readBody(req));
    if (!Object.prototype.hasOwnProperty.call(request, 'id')) {
      await this.dispatch(request);
      res.writeHead(202).end();
      return;
    }

    const response = await this.dispatch(request);
    this.writeJson(res, 200, response);
  }

  private async listen(server: Server, host: string, port: number): Promise<MCPServerHandle> {
    const closed = new Promise<void>(resolve => {
      server.once('close', resolve);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });

    const address = server.address() as AddressInfo;
    return {
      host,
      port: address.port,
      closed,
      close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    };
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private writeJson(res: ServerResponse, status: number, payload: Record<string, any>): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  private writeText(res: ServerResponse, status: number, text: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(text);
  }

  private normalizePath(path: string): string {
    return path.startsWith('/') ? path : `/${path}`;
  }

  private isAllowedOrigin(
    origin: string | string[] | undefined,
    host: string | string[] | undefined,
  ): boolean {
    const originValue = Array.isArray(origin) ? origin[0] : origin;
    if (!originValue) return true;

    const hostValue = Array.isArray(host) ? host[0] : host;
    if (!hostValue) return false;

    try {
      return new URL(originValue).host === hostValue;
    } catch {
      return false;
    }
  }

  private async handleRequest(method: string, params: Record<string, any>): Promise<any> {
    if (method === 'initialize') {
      return {
        protocolVersion: '2025-11-25',
        serverInfo: { name: this.name, version: this.version },
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          prompts: { listChanged: false },
        },
      };
    }

    if (method === 'notifications/initialized' || method === 'initialized') return { ok: true };
    if (method === 'ping') return { pong: true };
    if (method === 'tools/list' || method === 'tools.list') return { tools: this.listTools() };
    if (method === 'tools/call' || method === 'tools.call') {
      return this.callTool(params.name || '', params.arguments || {});
    }
    if (method === 'prompts/list' || method === 'prompts.list') return { prompts: this.listPrompts() };
    if (method === 'prompts/get' || method === 'prompts.get') {
      return this.getPrompt(params.name || '', params.arguments || {});
    }
    if (method === 'resources/list' || method === 'resources.list') return { resources: this.listResources() };
    if (method === 'resources/read' || method === 'resources.read') return this.readResource(params.uri || '');

    throw new MCPServerError(`method not found: ${method}`);
  }

  private listTools(): any[] {
    const tools: any[] = [];

    for (const [name, tool] of this.tools.entries()) {
      tools.push({
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }

    for (const [name] of this.agents.entries()) {
      tools.push({
        name,
        description: `AGNT5 agent: ${name}`,
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'User input for the agent' },
            session_id: { type: 'string' },
            max_iterations: { type: 'integer' },
          },
          required: ['input'],
        },
      });
    }

    for (const [name, workflow] of this.workflows.entries()) {
      tools.push({
        name,
        description: `AGNT5 workflow: ${name}`,
        inputSchema: workflow?._agnt5_config?.input_schema || {
          type: 'object',
          properties: {},
        },
      });
    }

    return tools;
  }

  private async callTool(name: string, args: Record<string, any>): Promise<any> {
    if (this.tools.has(name)) {
      const ctx = this.createContext(name);
      const result = await this.tools.get(name)!.invoke(ctx, args);
      return this.wrapTextResult(result);
    }

    if (this.agents.has(name)) {
      const input = args.input;
      if (typeof input !== 'string' || !input) {
        throw new MCPServerError("agent tools require a non-empty 'input' string");
      }
      const result = await this.agents.get(name)!.run(input, this.createContext(name));
      return this.wrapTextResult({
        output: result.output,
        toolCalls: result.toolCalls,
      });
    }

    if (this.workflows.has(name)) {
      const workflow = this.workflows.get(name)!;
      const result = await workflow(args);
      return this.wrapTextResult(result);
    }

    throw new MCPServerError(`unknown tool: ${name}`);
  }

  private listPrompts(): any[] {
    const prompts: any[] = [];
    for (const [name, prompt] of this.prompts.entries()) {
      const schema = prompt.argumentsSchema || {};
      const properties = schema.properties || {};
      const required = new Set(schema.required || []);
      prompts.push({
        name,
        description: prompt.description,
        arguments: Object.keys(properties).map(argName => ({
          name: argName,
          description: properties[argName]?.description,
          required: required.has(argName),
        })),
      });
    }
    return prompts;
  }

  private async getPrompt(name: string, args: Record<string, any>): Promise<any> {
    const prompt = this.prompts.get(name);
    if (!prompt) {
      throw new MCPServerError(`unknown prompt: ${name}`);
    }
    const result = await prompt.handler(args);
    let messages: PromptMessage[];
    if (typeof result === 'string') {
      messages = [{ role: 'user', content: { type: 'text', text: result } }];
    } else if (Array.isArray(result)) {
      messages = result;
    } else if (result && Array.isArray(result.messages)) {
      messages = result.messages;
    } else {
      messages = [{ role: 'user', content: { type: 'text', text: JSON.stringify(result) } }];
    }
    return {
      description: prompt.description,
      messages,
    };
  }

  private listResources(): any[] {
    return Array.from(this.resources.values()).map(resource => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
    }));
  }

  private async readResource(uri: string): Promise<any> {
    const resource = Array.from(this.resources.values()).find(item => item.uri === uri);
    if (!resource) {
      throw new MCPServerError(`unknown resource: ${uri}`);
    }
    const result = await resource.read();
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    return {
      contents: [
        {
          uri: resource.uri,
          mimeType: resource.mimeType || 'text/plain',
          text,
        },
      ],
    };
  }

  private wrapTextResult(result: any): any {
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    return {
      content: [{ type: 'text', text }],
      isError: false,
    };
  }

  private createContext(componentName: string): ContextImpl {
    return new ContextImpl(
      `mcp-${componentName}-${Date.now()}`,
      `run-${Date.now()}`,
      0,
      componentName,
    );
  }
}
