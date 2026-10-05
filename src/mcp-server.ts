import { ContextImpl } from './context.js';
import type { JSONSchema } from './types.js';
import { Tool } from './tool.js';
import { Agent } from './agent.js';
import { toJsonSchemaDocument } from './schema-utils.js';
import {
  AGENT_INPUT_SCHEMA,
  MCP_SCHEMA_VERSION,
  MCPServerRegistry,
  checkToolOptions,
  firstLine,
  objectSchema,
  toolDefinition,
  type MCPComponentType,
  type MCPServerDefinition,
  type MCPToolOptions,
  type PublishedTool,
} from './mcp-publish.js';

/** JSON-RPC 2.0 and MCP error codes. */
const MCP_ERROR_CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  RESOURCE_NOT_FOUND: -32002,
});

/** An MCP server error, answered with its JSON-RPC error `code`. */
export class MCPServerError extends Error {
  readonly code: number;

  constructor(message: string, code: number = MCP_ERROR_CODES.INTERNAL_ERROR) {
    super(message);
    this.name = 'MCPServerError';
    this.code = code;
  }
}

type JsonRpcResponse = Record<string, any>;

function errorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** MCP request ids are strings or integers, never null. */
function isValidId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value));
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  /** The server's name on the platform, part of its URL: lowercase letters, digits, `-` and `_`. */
  id: string;
  /** Name reported by `initialize` over stdio. Defaults to `id`. */
  name?: string;
  /** Defaults to `0.1.0`. */
  version?: string;
  /** Human-readable name shown by MCP clients. */
  title?: string;
  tools?: Record<string, Tool>;
  agents?: Record<string, Agent>;
  workflows?: Record<string, any>;
  prompts?: Record<string, Prompt>;
  resources?: Record<string, Resource>;
  instructions?: string;
  metadata?: Record<string, any>;
}

/**
 * An MCP server built from AGNT5 functions, workflows and agents.
 *
 * Published with the deployment: tools added with `addFunction`,
 * `addWorkflow` or `addAgent` are served at
 * `https://api.agnt5.com/mcp/{project}/{env}/{id}`, each call running as a
 * durable AGNT5 run:
 *
 * ```typescript
 * const support = new MCPServer('support', { instructions: 'Order and ticket tools.' });
 * support.addFunction('lookup_order', lookupOrder, { annotations: { readOnlyHint: true } });
 * support.addWorkflow('triage_ticket', triageTicket); // mode: 'auto'
 * ```
 *
 * The server's id is part of its URL: lowercase letters, digits, `-` and
 * `_`. `runStdio()` still serves it locally for development.
 */
export class MCPServer {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly title?: string;
  readonly instructions?: string;
  readonly metadata: Record<string, any>;

  private tools = new Map<string, Tool>();
  private agents = new Map<string, Agent>();
  private workflows = new Map<string, any>();
  private prompts = new Map<string, Prompt>();
  private resources = new Map<string, Resource>();
  private publishedTools = new Map<string, PublishedTool>();

  constructor(id: string, options?: Omit<MCPServerOptions, 'id'>);
  constructor(options: MCPServerOptions);
  constructor(idOrOptions: string | MCPServerOptions, maybeOptions: Omit<MCPServerOptions, 'id'> = {}) {
    const options: MCPServerOptions =
      typeof idOrOptions === 'string' ? { ...maybeOptions, id: idOrOptions } : idOrOptions;
    this.id = options.id;
    this.name = options.name || options.id;
    this.version = options.version || '0.1.0';
    this.title = options.title;
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
    MCPServerRegistry.register(this);
  }

  /** Serve a tool over `runStdio` only; it is not published. */
  addTool(name: string, tool: Tool): void {
    this.tools.set(name, tool);
  }

  /**
   * Publish a function (`fn(name).run(handler)`) as a tool. Functions wait
   * for their result (`mode: 'sync'`) unless told otherwise.
   */
  addFunction(name: string, func: unknown, options: MCPToolOptions = {}): void {
    const config = (func as any)?._agnt5_config;
    if (!config || typeof config.handler !== 'function' || typeof config.name !== 'string') {
      throw new TypeError(
        `addFunction(${JSON.stringify(name)}, ...) needs a function created with fn(name).run(handler)`,
      );
    }
    const fnOptions = config.options || {};
    this.publish(name, 'function', config.name, {
      inputSchema: fnOptions.inputSchema,
      outputSchema: fnOptions.outputSchema,
      defaultDescription: firstLine(fnOptions.description),
      options,
    });
  }

  /**
   * Publish a workflow (`workflow(name, handler)`) as a tool. By default a
   * call waits up to the server's call budget, then hands back a run handle
   * (`mode: 'auto'`). A plain function still serves over `runStdio` but is
   * not published.
   */
  addWorkflow(name: string, workflow: any, options: MCPToolOptions = {}): void {
    const config = workflow?._agnt5_config;
    if (config && typeof config.handler === 'function' && typeof config.name === 'string') {
      this.publish(name, 'workflow', config.name, {
        inputSchema: config.inputSchema,
        outputSchema: config.outputSchema,
        defaultDescription: firstLine(config.description),
        options,
      });
    }
    this.workflows.set(name, workflow);
  }

  /**
   * Publish an agent as a tool that takes a message (and optionally a
   * session to continue). The worker serves the agent; no
   * `registerAgents` call is needed for it.
   */
  addAgent(name: string, agent: Agent, options: MCPToolOptions = {}): void {
    if (!agent || typeof agent.name !== 'string' || !agent.name) {
      throw new TypeError(`addAgent(${JSON.stringify(name)}, ...) needs an Agent`);
    }
    this.publish(name, 'agent', agent.name, {
      inputSchema: AGENT_INPUT_SCHEMA,
      outputSchema: undefined,
      defaultDescription: firstLine((agent as any).description) || firstLine(agent.instructions),
      options,
      target: agent,
    });
    this.agents.set(name, agent);
  }

  /** Whether the worker publishes this server with the deployment. */
  get published(): boolean {
    return this.publishedTools.size > 0;
  }

  /** The tools this server publishes, in the order they were added. */
  publishedToolList(): PublishedTool[] {
    return Array.from(this.publishedTools.values());
  }

  /** The definition the worker registers (platform contract, version 1). */
  definition(): MCPServerDefinition {
    const definition: MCPServerDefinition = {
      schema_version: MCP_SCHEMA_VERSION,
      name: this.id,
      tools: this.publishedToolList().map(toolDefinition),
    };
    if (this.title) definition.title = this.title;
    if (this.instructions) definition.instructions = this.instructions;
    return definition;
  }

  private publish(
    name: string,
    componentType: MCPComponentType,
    componentName: string,
    spec: {
      inputSchema: unknown;
      outputSchema: unknown;
      defaultDescription?: string;
      options: MCPToolOptions;
      target?: unknown;
    },
  ): void {
    const { options } = spec;
    const annotations = checkToolOptions(name, options);
    if (this.publishedTools.has(name)) {
      throw new Error(`MCP server ${JSON.stringify(this.id)} already has a tool named ${JSON.stringify(name)}`);
    }
    this.publishedTools.set(name, {
      name,
      componentType,
      componentName,
      inputSchema: objectSchema(toJsonSchemaDocument(spec.inputSchema, 'input')) ?? {
        type: 'object',
        properties: {},
      },
      outputSchema: objectSchema(toJsonSchemaDocument(spec.outputSchema, 'output')),
      title: options.title,
      description: options.description || spec.defaultDescription,
      mode: options.mode,
      visibility: options.visibility ? [...options.visibility] : undefined,
      annotations,
      target: spec.target,
    });
  }

  addPrompt(name: string, prompt: Prompt): void {
    this.prompts.set(name, prompt);
  }

  addResource(name: string, resource: Resource): void {
    this.resources.set(name, resource);
  }

  /** Serve MCP JSON-RPC over stdio using newline-delimited JSON. */
  async runStdio(): Promise<void> {
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    for await (const chunk of process.stdin) {
      buffer = Buffer.concat([buffer, chunk]);
      let lineEnd: number;
      while ((lineEnd = buffer.indexOf('\n')) !== -1) {
        const line = buffer.subarray(0, lineEnd).toString('utf8').replace(/\r$/, '');
        buffer = Buffer.from(buffer.subarray(lineEnd + 1));
        const response = await this.handleLine(line);
        if (response) this.writeMessage(Buffer.from(JSON.stringify(response), 'utf8'));
      }
    }
  }

  /**
   * Handle one JSON-RPC message and return the response to send, or
   * `undefined` for a notification (a message without an `id`) or a response
   * from the client: neither gets a reply. Exposed for tests and embeddings.
   */
  async dispatch(request: unknown): Promise<JsonRpcResponse | undefined> {
    if (!isPlainObject(request)) {
      return errorResponse(null, MCP_ERROR_CODES.INVALID_REQUEST, 'Invalid Request: expected a JSON object');
    }
    const hasId = Object.prototype.hasOwnProperty.call(request, 'id');
    if (hasId && !isValidId(request.id)) {
      return errorResponse(null, MCP_ERROR_CODES.INVALID_REQUEST, 'Invalid Request: id must be a string or an integer');
    }
    const id: string | number | null = hasId ? request.id : null;
    if (request.jsonrpc !== '2.0') {
      return errorResponse(id, MCP_ERROR_CODES.INVALID_REQUEST, 'Invalid Request: "jsonrpc" must be "2.0"');
    }
    const method = request.method;
    if (method === undefined && ('result' in request || 'error' in request)) {
      // A response to a request this server never sends.
      return undefined;
    }
    if (typeof method !== 'string' || !method) {
      return errorResponse(id, MCP_ERROR_CODES.INVALID_REQUEST, 'Invalid Request: "method" must be a string');
    }
    if (!hasId) {
      // Notifications (notifications/initialized, notifications/cancelled,
      // ...) are never answered, not even with an error.
      return undefined;
    }
    const params = request.params ?? {};
    if (!isPlainObject(params)) {
      return errorResponse(id, MCP_ERROR_CODES.INVALID_PARAMS, 'Invalid params: "params" must be an object');
    }
    try {
      return { jsonrpc: '2.0', id, result: await this.handleRequest(method, params) };
    } catch (error: any) {
      const code = error instanceof MCPServerError ? error.code : MCP_ERROR_CODES.INTERNAL_ERROR;
      return errorResponse(id, code, error?.message || String(error));
    }
  }

  /** Parse one stdio line and dispatch it. */
  private async handleLine(line: string): Promise<JsonRpcResponse | undefined> {
    if (!line.trim()) return undefined;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error: any) {
      return errorResponse(null, MCP_ERROR_CODES.PARSE_ERROR, `Parse error: ${error?.message || String(error)}`);
    }
    return this.dispatch(message);
  }

  private writeMessage(payload: Buffer): void {
    process.stdout.write(payload);
    process.stdout.write('\n');
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

    if (method === 'ping') return {};
    if (method === 'tools/list' || method === 'tools.list') return { tools: this.listTools() };
    if (method === 'tools/call' || method === 'tools.call') {
      const name = params.name;
      if (typeof name !== 'string' || !name) {
        throw new MCPServerError('Invalid params: "name" must be a tool name', MCP_ERROR_CODES.INVALID_PARAMS);
      }
      const args = params.arguments ?? {};
      if (!isPlainObject(args)) {
        throw new MCPServerError('Invalid params: "arguments" must be an object', MCP_ERROR_CODES.INVALID_PARAMS);
      }
      return this.callTool(name, args);
    }
    if (method === 'prompts/list' || method === 'prompts.list') return { prompts: this.listPrompts() };
    if (method === 'prompts/get' || method === 'prompts.get') {
      return this.getPrompt(params.name || '', params.arguments || {});
    }
    if (method === 'resources/list' || method === 'resources.list') return { resources: this.listResources() };
    if (method === 'resources/read' || method === 'resources.read') return this.readResource(params.uri || '');

    throw new MCPServerError(`Method not found: ${method}`, MCP_ERROR_CODES.METHOD_NOT_FOUND);
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
    let call: () => Promise<any>;
    if (this.tools.has(name)) {
      call = () => this.tools.get(name)!.invoke(this.createContext(name), args);
    } else if (this.agents.has(name)) {
      call = async () => {
        const input = args.input;
        if (typeof input !== 'string' || !input) {
          throw new MCPServerError("agent tools require a non-empty 'input' string");
        }
        const result = await this.agents.get(name)!.run(input, this.createContext(name));
        return { output: result.output, toolCalls: result.toolCalls };
      };
    } else if (this.workflows.has(name)) {
      const workflow = this.workflows.get(name)!;
      call = async () => workflow(args);
    } else {
      throw new MCPServerError(`Unknown tool: ${name}`, MCP_ERROR_CODES.INVALID_PARAMS);
    }
    try {
      return this.wrapTextResult(await call());
    } catch (error: any) {
      // A tool execution error, not a protocol one, so the model can read it
      // and correct the call (as the hosted server does).
      return this.wrapTextResult(`${name} failed: ${error?.message || String(error)}`, true);
    }
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
      throw new MCPServerError(`Unknown prompt: ${name}`, MCP_ERROR_CODES.INVALID_PARAMS);
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
      throw new MCPServerError(`Resource not found: ${uri}`, MCP_ERROR_CODES.RESOURCE_NOT_FOUND);
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

  private wrapTextResult(result: any, isError = false): any {
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    return {
      content: [{ type: 'text', text }],
      isError,
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
