/**
 * Example: MCP (Model Context Protocol) integration
 *
 * Demonstrates connecting to MCP servers to discover and use external tools.
 */

import { MCPClient, Agent, LM } from '../src/index.js';

// ─── 1. Basic MCP client setup ──────────────────────────────────────

async function basicMCPSetup() {
  console.log('=== Basic MCP setup ===\n');

  // Create client with server configurations
  const mcp = new MCPClient('my-tools', {
    // Stdio server: runs a subprocess
    wikipedia: { command: 'npx', args: ['-y', 'wikipedia-mcp'] },
  });

  // Or add servers programmatically
  mcp.addStdioServer('filesystem', 'npx', ['-y', 'fs-mcp'], undefined, process.cwd());

  // SSE server (remote)
  mcp.addSseServer('remote-tools', 'https://example.com/mcp', {
    Authorization: 'Bearer token',
  });

  console.log('Configured servers (not connected yet)');
  console.log('Connected servers:', mcp.connectedServers());
}

// ─── 2. Connect and discover tools ──────────────────────────────────

async function connectAndDiscover() {
  console.log('=== Connect and discover tools ===\n');

  const mcp = new MCPClient('tool-discovery');

  // Add a server (use a real MCP server for this to work)
  mcp.addStdioServer('demo', 'npx', ['-y', 'some-mcp-server']);

  try {
    await mcp.connect();

    // List all discovered tools
    const tools = mcp.listTools();
    console.log(`Discovered ${tools.length} tools:`);
    for (const { server, tool } of tools) {
      console.log(`  [${server}] ${tool.name}: ${tool.description}`);
    }

    // List tools from a specific server
    const serverTools = mcp.listServerTools('demo');
    console.log(`Server 'demo' has ${serverTools.length} tools`);

    // Call a tool directly
    const result = await mcp.callTool('demo', 'some-tool', { query: 'test' });
    console.log('Tool result:', result.content);

    // Auto-find and call a tool by name across all servers
    const autoResult = await mcp.callToolAuto('some-tool', { query: 'test' });
    console.log('Auto result:', autoResult.content);

    await mcp.disconnect();
  } catch (error) {
    console.log('(Skipped: MCP server not available)');
  }
}

// ─── 3. Use MCP tools with an Agent ─────────────────────────────────

async function agentWithMCPTools() {
  console.log('=== Agent with MCP tools ===\n');

  const mcp = new MCPClient('agent-tools');
  mcp.addStdioServer('wikipedia', 'npx', ['-y', 'wikipedia-mcp']);

  try {
    await mcp.connect();

    // Convert MCP tools to AGNT5 Tool objects
    const tools = mcp.getTools();
    console.log(`Converted ${tools.length} MCP tools for agent use`);

    const model = new LM({ provider: 'openai', model: 'gpt-4o-mini' });

    // Create agent with MCP-provided tools
    const researcher = new Agent({
      name: 'researcher',
      model,
      tools,
      instructions: 'You are a research assistant. Use the available tools to find information.',
    });

    const result = await researcher.run('What is the capital of France?');
    console.log('Agent result:', result.output);

    await mcp.disconnect();
  } catch (error) {
    console.log('(Skipped: MCP server not available)');
  }
}

// ─── 4. Dictionary-based configuration ──────────────────────────────

async function dictConfig() {
  console.log('=== Dictionary-based configuration ===\n');

  // Pass server configs as a dictionary (common pattern)
  const mcp = new MCPClient('from-dict', {
    // Stdio servers have 'command'
    local: {
      command: 'python',
      args: ['-m', 'my_mcp_server'],
      env: { DEBUG: '1' },
    },
    // SSE servers have 'url'
    remote: {
      url: 'https://api.example.com/mcp',
      headers: { Authorization: 'Bearer token' },
    },
  });

  console.log('Client ID:', mcp.id);
  console.log('Configured servers (pre-connect):', mcp.connectedServers());
}

// ─── Run examples ───────────────────────────────────────────────────

async function main() {
  await basicMCPSetup();
  await dictConfig();
  // These require actual MCP servers:
  // await connectAndDiscover();
  // await agentWithMCPTools();
}

main().catch(console.error);
