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

  async runSSE(_options?: { host?: string; port?: number }): Promise<void> {
    throw new Error('MCPServer.runSSE() is not implemented yet');
  }

  async runHTTP(_options?: { host?: string; port?: number; path?: string }): Promise<void> {
    throw new Error('MCPServer.runHTTP() is not implemented yet');
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
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return null;

    const header = buffer.subarray(0, headerEnd).toString('utf8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      throw new MCPServerError('Missing Content-Length header');
    }

    const contentLength = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) return null;

    const body = buffer.subarray(bodyStart, bodyStart + contentLength);
    return {
      request: JSON.parse(body.toString('utf8')),
      remaining: Buffer.from(buffer.subarray(bodyStart + contentLength)),
    };
  }

  private writeMessage(payload: Buffer): void {
    process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
    process.stdout.write(payload);
  }

  private async handleRequest(method: string, params: Record<string, any>): Promise<any> {
    if (method === 'initialize') {
      return {
        protocolVersion: '2024-11-05',
        serverInfo: { name: this.name, version: this.version },
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          prompts: { listChanged: false },
        },
      };
    }

    if (method === 'initialized') return { ok: true };
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
