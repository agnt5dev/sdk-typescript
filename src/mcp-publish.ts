/**
 * Publishing MCP servers with a deployment (AGNT5-1569).
 *
 * An `MCPServer` that names functions, workflows or agents through
 * `addFunction` / `addWorkflow` / `addAgent` is registered by the worker as a
 * component of type `mcp`. Its definition follows the platform contract
 * (docs/architecture/mcp-server-definition.md in the AGNT5 repo,
 * `schema_version` 1): the hosted MCP server then calls those components as
 * durable runs. Mirrors `agnt5.mcp.publish` in the Python SDK.
 */

import type { JSONSchema } from './types.js';
import type { MCPServer } from './mcp-server.js';

export const MCP_SCHEMA_VERSION = 1;

export const MCP_TOOL_MODES = ['sync', 'auto', 'background'] as const;
export const MCP_TOOL_VISIBILITIES = ['model', 'app'] as const;
const ANNOTATION_HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;
const RESERVED_TOOL_NAMES = new Set(['get_run', 'cancel_run']);

/**
 * The default `view`: the AGNT5 run card that MCP Apps hosts (ChatGPT,
 * Claude, Cursor, VS Code) show for `auto` and `background` tools while their
 * run goes on. Pass `view: null` to turn it off for a tool.
 */
export const MCP_RUN_VIEW = 'run';
/** How a definition says a tool has no view. */
const NO_VIEW = 'none';

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const SERVER_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * How a tools/call waits for its run: `sync` waits for the result, `auto`
 * waits up to the server's call budget and then hands back a run handle,
 * `background` hands back the handle at once. Default: `sync` for functions,
 * `auto` for workflows and agents.
 */
export type MCPToolMode = (typeof MCP_TOOL_MODES)[number];

/** A tool's MCP Apps view: the run card (the default) or `null` for none. */
export type MCPToolView = typeof MCP_RUN_VIEW | null;

/** Who can call the tool: the model, an app view, or both (the default). */
export type MCPToolVisibility = (typeof MCP_TOOL_VISIBILITIES)[number];

/** MCP tool hints. A tool that doesn't say it only reads is treated as one that writes. */
export interface MCPToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Options for `MCPServer.addFunction` / `addWorkflow` / `addAgent`. */
export interface MCPToolOptions {
  title?: string;
  /** Defaults to the component's description (an agent's first line of instructions). */
  description?: string;
  mode?: MCPToolMode;
  visibility?: MCPToolVisibility[];
  annotations?: MCPToolAnnotations;
  /**
   * `null` turns off the AGNT5 run card that MCP Apps clients show for
   * `auto` and `background` calls. Default: {@link MCP_RUN_VIEW}.
   */
  view?: MCPToolView;
}

export type MCPComponentType = 'function' | 'workflow' | 'agent';

/** One tool in a published server definition. */
export interface MCPToolDefinition {
  name: string;
  title?: string;
  description?: string;
  component: { type: MCPComponentType; name: string };
  mode?: MCPToolMode;
  visibility?: MCPToolVisibility[];
  annotations: MCPToolAnnotations;
  input_schema: JSONSchema;
  output_schema?: JSONSchema;
  /** `none` when the tool shows no view; absent for the default (the run card). */
  view?: typeof NO_VIEW;
}

/** The definition the worker registers for a server (contract version 1). */
export interface MCPServerDefinition {
  schema_version: typeof MCP_SCHEMA_VERSION;
  name: string;
  title?: string;
  instructions?: string;
  tools: MCPToolDefinition[];
}

/** Input every published agent takes: the message, and an optional session to continue. */
export const AGENT_INPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    input: { type: 'string', description: 'The message for the agent.' },
    session_id: { type: 'string', description: 'Continue an earlier conversation.' },
  },
  required: ['input'],
};

/** One tool of a published server and the component it calls. */
export interface PublishedTool {
  name: string;
  componentType: MCPComponentType;
  componentName: string;
  inputSchema: JSONSchema;
  outputSchema?: JSONSchema;
  title?: string;
  description?: string;
  mode?: MCPToolMode;
  visibility?: MCPToolVisibility[];
  annotations: MCPToolAnnotations;
  /** `null` when the run card is off. */
  view?: MCPToolView;
  /** The component itself (for agents, so the worker can serve it). Not published. */
  target?: unknown;
}

export function toolDefinition(tool: PublishedTool): MCPToolDefinition {
  const definition: MCPToolDefinition = {
    name: tool.name,
    component: { type: tool.componentType, name: tool.componentName },
    input_schema: tool.inputSchema,
    // ChatGPT requires explicit hints; a tool that doesn't say it only reads
    // is treated as one that writes.
    annotations: { readOnlyHint: false, ...tool.annotations },
  };
  if (tool.title) definition.title = tool.title;
  if (tool.description) definition.description = tool.description;
  if (tool.mode) definition.mode = tool.mode;
  if (tool.visibility?.length) definition.visibility = [...tool.visibility];
  if (tool.outputSchema) definition.output_schema = tool.outputSchema;
  if (tool.view === null) definition.view = NO_VIEW;
  return definition;
}

/**
 * Validate `add*` options where the developer wrote them, so a typo fails at
 * startup rather than as a rejected deployment. Returns the annotations to
 * publish.
 */
export function checkToolOptions(name: string, options: MCPToolOptions = {}): MCPToolAnnotations {
  if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
    throw new Error(`MCP tool name ${JSON.stringify(name)} must be 1 to 128 letters, digits, '_', '-' or '.'`);
  }
  if (RESERVED_TOOL_NAMES.has(name)) {
    throw new Error(`MCP tool name ${JSON.stringify(name)} is reserved for the built-in run tools`);
  }
  const { mode, visibility, annotations, view } = options;
  if (view !== undefined && view !== null && view !== MCP_RUN_VIEW) {
    throw new Error(
      `view must be ${JSON.stringify(MCP_RUN_VIEW)} (the AGNT5 run card) or null (no view), not ${JSON.stringify(view)}`,
    );
  }
  if (mode !== undefined && !(MCP_TOOL_MODES as readonly unknown[]).includes(mode)) {
    throw new Error(`mode must be one of ${MCP_TOOL_MODES.join(', ')}, not ${JSON.stringify(mode)}`);
  }
  if (visibility !== undefined) {
    const valid =
      Array.isArray(visibility) &&
      visibility.length > 0 &&
      visibility.every(v => (MCP_TOOL_VISIBILITIES as readonly unknown[]).includes(v)) &&
      new Set(visibility).size === visibility.length;
    if (!valid) {
      throw new Error(`visibility must be a non-empty list of ${MCP_TOOL_VISIBILITIES.join(', ')}`);
    }
  }
  const clean: MCPToolAnnotations = {};
  for (const [key, value] of Object.entries(annotations ?? {})) {
    if (value === undefined) continue;
    if (key === 'title') {
      if (typeof value !== 'string') throw new Error("annotations.title must be a string");
    } else if ((ANNOTATION_HINTS as readonly string[]).includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`annotations.${key} must be true or false`);
    } else {
      throw new Error(`unknown annotation ${JSON.stringify(key)}; use ${ANNOTATION_HINTS.join(', ')} or title`);
    }
    (clean as Record<string, unknown>)[key] = value;
  }
  return clean;
}

/** MCP tool schemas must describe an object; anything else is left out. */
export function objectSchema(schema: JSONSchema | undefined): JSONSchema | undefined {
  return schema && typeof schema === 'object' && schema.type === 'object' ? schema : undefined;
}

export function firstLine(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  for (const line of text.trim().split(/\r?\n/)) {
    if (line.trim()) return line.trim();
  }
  return undefined;
}

/** A published server's name is a URL segment: /mcp/{project}/{env}/{name}. */
export function validServerName(name: string): boolean {
  return SERVER_NAME.test(name);
}

/** Servers defined in the worker's code, published at startup. */
export class MCPServerRegistry {
  private static servers = new Map<string, MCPServer>();

  static register(server: MCPServer): void {
    this.servers.set(server.id, server);
  }

  static discard(name: string): void {
    this.servers.delete(name);
  }

  static get(name: string): MCPServer | undefined {
    return this.servers.get(name);
  }

  static all(): Map<string, MCPServer> {
    return new Map(this.servers);
  }

  static clear(): void {
    this.servers.clear();
  }
}
