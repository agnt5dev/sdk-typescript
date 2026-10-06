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

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/** The most one view's HTML may weigh, in bytes. */
export const MCP_MAX_VIEW_BYTES = 2 * 1024 * 1024;
/**
 * The most the views of the servers a worker publishes may take of its
 * registration together, measured as they travel there
 * ({@link viewRegistrationBytes}): AGNT5 accepts a registration up to 4 MB.
 */
export const MCP_MAX_VIEWS_BYTES = 3 * 1024 * 1024;
const RESERVED_VIEW_NAMES = new Set([MCP_RUN_VIEW, NO_VIEW]);

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const SERVER_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * How a tools/call waits for its run: `sync` waits for the result, `auto`
 * waits up to the server's call budget and then hands back a run handle,
 * `background` hands back the handle at once. Default: `sync` for functions,
 * `auto` for workflows and agents.
 */
export type MCPToolMode = (typeof MCP_TOOL_MODES)[number];

/**
 * An MCP App view a server ships: one self-contained HTML file that clients
 * rendering MCP Apps (ChatGPT, Claude, Cursor, VS Code) show for the results
 * of the tools that name it. Made by `MCPServer.addView`; pass it (or its
 * name) as a tool's `view`.
 *
 * The bundle travels with the worker's registration; AGNT5 stores it by
 * `sha256` and serves it at `ui://{server}/{name}/{sha256 first 16}`.
 */
export class MCPView {
  /** The bundle, kept out of enumeration so logging a view stays short. */
  declare readonly html: string;
  /** What the bundle takes of the worker's registration ({@link viewRegistrationBytes}). */
  readonly registrationBytes: number;

  constructor(
    readonly name: string,
    readonly sha256: string,
    readonly size: number,
    /** The server that ships it. */
    readonly server: string,
    html: string,
  ) {
    Object.defineProperty(this, 'html', { value: html, enumerable: false });
    this.registrationBytes = viewRegistrationBytes(html);
  }

  toDefinition(): MCPViewDefinition {
    return { name: this.name, sha256: this.sha256, size: this.size, html: this.html };
  }
}

/** Where a view's HTML comes from: its text, or the built file. */
export type MCPViewSource = { html: string; path?: never } | { path: string | URL; html?: never };

/**
 * A tool's MCP Apps view: the run card (the default), `null` for none, or
 * one of the server's own views (`addView`), by handle or name.
 */
export type MCPToolView = typeof MCP_RUN_VIEW | MCPView | string | null;

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
   * `auto` and `background` calls; one of the server's own views
   * (`addView`) shows that instead, for every call, `sync` ones too.
   * Default: {@link MCP_RUN_VIEW}.
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
  /**
   * `none` when the tool shows no view, the name of one of the server's
   * `views`, or absent for the default (the run card).
   */
  view?: string;
}

/** A view in a published definition, its bundle included. */
export interface MCPViewDefinition {
  name: string;
  sha256: string;
  size: number;
  html: string;
}

/** The definition the worker registers for a server (contract version 1). */
export interface MCPServerDefinition {
  schema_version: typeof MCP_SCHEMA_VERSION;
  name: string;
  title?: string;
  instructions?: string;
  tools: MCPToolDefinition[];
  views?: MCPViewDefinition[];
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
  /** `null` when the run card is off; a view name for one of the server's own. */
  view?: string | null;
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
  else if (tool.view !== undefined && tool.view !== MCP_RUN_VIEW) definition.view = tool.view;
  return definition;
}

/**
 * How many bytes a view bundle takes in the worker's registration. The
 * definition carrying it travels as a JSON string inside a JSON webhook, so
 * the HTML is JSON-escaped twice: `"` and `\` take 4 bytes, `\b \f \n \r
 * \t` take 3, other control characters 7, everything else its UTF-8 length.
 * The platform measures the same way (`ViewRegistrationBytes`), whatever JSON
 * encoder either side uses.
 */
export function viewRegistrationBytes(html: string): number {
  let size = new TextEncoder().encode(html).length;
  for (let i = 0; i < html.length; i++) {
    const code = html.charCodeAt(i);
    if (code === 0x22 || code === 0x5c) size += 3;
    else if (code === 0x08 || code === 0x0c || code === 0x0a || code === 0x0d || code === 0x09) size += 2;
    else if (code < 0x20) size += 6;
  }
  return size;
}

/** Whether `text` has no unpaired UTF-16 surrogates. */
function isWellFormed(text: string): boolean {
  const native = (text as { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof native === 'function') return native.call(text);
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

/**
 * Refuse a worker whose published servers' views together pass
 * {@link MCP_MAX_VIEWS_BYTES} of its registration: the registration would
 * be rejected whole, taking every component with it.
 */
export function checkViewsBudget(servers: Iterable<MCPServer>): void {
  let total = 0;
  const sizes: string[] = [];
  for (const server of servers) {
    for (const view of server.views.values()) {
      total += view.registrationBytes;
      sizes.push(`${server.id}/${view.name} ${view.registrationBytes}`);
    }
  }
  if (total > MCP_MAX_VIEWS_BYTES) {
    throw new Error(
      `this worker's MCP views take ${total} bytes of its registration together; the limit is ${MCP_MAX_VIEWS_BYTES} (${sizes.join(', ')})`,
    );
  }
}

/**
 * Check a view where the developer added it, so a missing build or an
 * oversized bundle fails at startup rather than as a rejected deployment.
 */
export function loadView(server: string, name: string, source: MCPViewSource): MCPView {
  if (typeof name !== 'string' || !SERVER_NAME.test(name)) {
    throw new Error(
      `view name ${JSON.stringify(name)} must be lowercase letters, digits, '-' and '_' (up to 63 characters)`,
    );
  }
  if (RESERVED_VIEW_NAMES.has(name)) {
    throw new Error(
      `view name ${JSON.stringify(name)} is reserved (${JSON.stringify(MCP_RUN_VIEW)} is the AGNT5 run card, ${JSON.stringify(NO_VIEW)} means no view)`,
    );
  }
  const hasHtml = source?.html !== undefined;
  const hasPath = source?.path !== undefined;
  if (hasHtml === hasPath) {
    throw new Error(`addView(${JSON.stringify(name)}, ...) takes one of { html } or { path }`);
  }
  let html = source.html;
  if (hasPath) {
    const path = source.path as string | URL;
    const shown = path instanceof URL ? fileURLToPath(path) : path;
    let bytes: Uint8Array;
    try {
      // Too big is refused before anything is read.
      const onDisk = statSync(path).size;
      if (onDisk > MCP_MAX_VIEW_BYTES) {
        throw new Error(`view ${JSON.stringify(name)} is ${onDisk} bytes; the limit is ${MCP_MAX_VIEW_BYTES}`);
      }
      bytes = readFileSync(path);
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        throw new Error(
          `view ${JSON.stringify(name)}: ${shown} does not exist. Build it first: one self-contained HTML file (for example Vite with vite-plugin-singlefile)`,
        );
      }
      throw error;
    }
    try {
      html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`view ${JSON.stringify(name)}: ${shown} is not UTF-8 text`);
    }
  }
  if (typeof html !== 'string' || !html.trim()) {
    throw new Error(`view ${JSON.stringify(name)} has no HTML`);
  }
  // A lone surrogate isn't text: UTF-8 can't carry it (TextEncoder would
  // swap in U+FFFD, changing the hash), and JSON escapes it to \udXXX, past
  // what the registration budget counts. A file read as UTF-8 never has one.
  if (!isWellFormed(html)) {
    throw new Error(`view ${JSON.stringify(name)}: its HTML contains unpaired UTF-16 surrogates`);
  }
  const data = new TextEncoder().encode(html);
  if (data.length > MCP_MAX_VIEW_BYTES) {
    throw new Error(`view ${JSON.stringify(name)} is ${data.length} bytes; the limit is ${MCP_MAX_VIEW_BYTES}`);
  }
  const sha256 = createHash('sha256').update(data).digest('hex');
  return new MCPView(name, sha256, data.length, server, html);
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
  const { mode, visibility, annotations } = options;
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
