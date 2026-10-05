/**
 * Who called a run through a hosted MCP server.
 *
 * `ctx.caller` is set when a tool call on a hosted MCP server started the
 * run, and `undefined` otherwise. AGNT5 verifies the caller before the run
 * starts; no token or credential is ever exposed here.
 */
export interface Caller {
  /** The hosted MCP server that took the call. */
  readonly server: string;
  /** The tool that was called. */
  readonly tool: string;
  /** The verified caller: an AGNT5 user id for OAuth, `service_key:{id}` for an API key. */
  readonly subject: string;
  /** How the caller authenticated: `'oauth'` or `'api_key'`. */
  readonly authMethod: string;
  /** The MCP client: its OAuth client id, or its User-Agent. */
  readonly client: string;
}

/**
 * Read the MCP caller from a run's dispatch metadata.
 *
 * The runtime stamps `trigger_type=mcp` and the `mcp.*` keys on a run a
 * hosted MCP server starts, and rejects `mcp.*` keys from anyone else, so a
 * run without `mcp.server` has no MCP caller.
 */
export function callerFromMetadata(metadata?: Record<string, string>): Caller | undefined {
  if (!metadata || metadata.trigger_type !== 'mcp') return undefined;
  const server = metadata['mcp.server'];
  if (!server) return undefined;
  return Object.freeze({
    server: String(server),
    tool: String(metadata['mcp.tool'] ?? ''),
    subject: String(metadata['mcp.subject'] ?? ''),
    authMethod: String(metadata['mcp.auth_method'] ?? ''),
    client: String(metadata['mcp.client'] ?? ''),
  });
}
