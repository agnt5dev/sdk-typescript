import { describe, it, expect } from 'vitest';
import { Agent } from '../agent.js';
import type { GenerateRequest, GenerateResponse, LanguageModel } from '../agent.js';
import { MCPServer, Prompt, Resource } from '../mcp-server.js';
import { Tool } from '../tool.js';
import { workflow } from '../workflow.js';

class MockLanguageModel implements LanguageModel {
  async generate(_request: GenerateRequest): Promise<GenerateResponse> {
    return { text: 'Agent answer', finishReason: 'stop' };
  }
}

describe('MCPServer', () => {
  it('lists and calls registered tools, agents, and workflows', async () => {
    const echoTool = new Tool(
      'echo',
      'Echo a message',
      async (_ctx, args: { message: string }) => `echo:${args.message}`,
      {
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
          required: ['message'],
        },
      },
    );

    const summarizeTopic = workflow('summarize_topic', async (_ctx, input: { topic: string }) => {
      return { topic: input.topic, summary: 'done' };
    });

    const agent = new Agent({
      name: 'research_agent',
      model: new MockLanguageModel(),
      instructions: 'Be helpful',
    });

    const server = new MCPServer({
      id: 'test-mcp',
      name: 'Test MCP',
      version: '1.0.0',
      tools: { echo: echoTool },
      agents: { research_agent: agent },
      workflows: { summarize_topic: summarizeTopic },
    });

    const listed = await server.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });

    const toolNames = new Set((listed.result.tools as Array<{ name: string }>).map(t => t.name));
    expect(toolNames.has('echo')).toBe(true);
    expect(toolNames.has('research_agent')).toBe(true);
    expect(toolNames.has('summarize_topic')).toBe(true);

    const echoResponse = await server.dispatch({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'echo',
        arguments: { message: 'hello' },
      },
    });
    expect(echoResponse.result.content[0].text).toBe('echo:hello');

    const workflowResponse = await server.dispatch({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'summarize_topic',
        arguments: { topic: 'mcp' },
      },
    });
    expect(workflowResponse.result.content[0].text).toContain('"summary":"done"');

    const agentResponse = await server.dispatch({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'research_agent',
        arguments: { input: 'hi' },
      },
    });
    expect(agentResponse.result.content[0].text).toContain('"output":"Agent answer"');
  });

  it('lists and resolves prompts and resources', async () => {
    const server = new MCPServer({
      id: 'test-mcp',
      name: 'Test MCP',
      version: '1.0.0',
      prompts: {
        research_brief: new Prompt({
          name: 'research_brief',
          description: 'Build a research brief',
          argumentsSchema: {
            type: 'object',
            properties: {
              topic: { type: 'string' },
            },
            required: ['topic'],
          },
          handler: async ({ topic }) => ({
            messages: [
              {
                role: 'user',
                content: { type: 'text', text: `Research ${topic}` },
              },
            ],
          }),
        }),
      },
      resources: {
        'docs://handbook': Resource.text({
          uri: 'docs://handbook',
          name: 'Handbook',
          mimeType: 'text/markdown',
          read: async () => '# Handbook',
        }),
      },
    });

    const promptsResponse = await server.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'prompts/list',
      params: {},
    });
    expect(promptsResponse.result.prompts[0].name).toBe('research_brief');

    const promptResponse = await server.dispatch({
      jsonrpc: '2.0',
      id: 2,
      method: 'prompts/get',
      params: {
        name: 'research_brief',
        arguments: { topic: 'AGNT5' },
      },
    });
    expect(promptResponse.result.messages[0].content.text).toBe('Research AGNT5');

    const resourcesResponse = await server.dispatch({
      jsonrpc: '2.0',
      id: 3,
      method: 'resources/list',
      params: {},
    });
    expect(resourcesResponse.result.resources[0].uri).toBe('docs://handbook');

    const resourceResponse = await server.dispatch({
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/read',
      params: { uri: 'docs://handbook' },
    });
    expect(resourceResponse.result.contents[0].text).toBe('# Handbook');
  });

  it('parses and writes stdio messages using JSONL framing', () => {
    const server = new MCPServer({
      id: 'test-mcp',
      name: 'Test MCP',
      version: '1.0.0',
    });
    const first = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
    const second = '{"jsonrpc":"2.0","id":2,"method":"ping"}';

    const parsed = (server as any).tryParseMessage(Buffer.from(`${first}\r\n${second}\n`));

    expect(parsed.request).toEqual({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(parsed.remaining.toString('utf8')).toBe(`${second}\n`);

    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    (process.stdout as any).write = (chunk: any, ...args: any[]) => {
      writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      const callback = args.find(arg => typeof arg === 'function');
      if (callback) callback();
      return true;
    };
    try {
      (server as any).writeMessage(Buffer.from(first, 'utf8'));
    } finally {
      (process.stdout as any).write = originalWrite;
    }

    const output = writes.join('');
    expect(output).toBe(`${first}\n`);
    expect(output).not.toContain('Content-Length');
  });

  it('serves Streamable HTTP requests', async () => {
    const server = new MCPServer({
      id: 'test-mcp',
      name: 'Test MCP',
      version: '1.0.0',
    });
    const handle = await (server as any).startHTTP({ host: '127.0.0.1', port: 0 });

    try {
      const response = await fetch(`http://${handle.host}:${handle.port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      const body = await response.json() as any;

      expect(response.status).toBe(200);
      expect(body.result.serverInfo.name).toBe('Test MCP');
      expect(body.result.protocolVersion).toBe('2025-11-25');
    } finally {
      await handle.close();
    }
  });

  it('rejects cross-origin Streamable HTTP requests', async () => {
    const server = new MCPServer({
      id: 'test-mcp',
      name: 'Test MCP',
      version: '1.0.0',
    });
    const handle = await (server as any).startHTTP({ host: '127.0.0.1', port: 0 });

    try {
      const response = await fetch(`http://${handle.host}:${handle.port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://evil.example',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
      });
      expect(response.status).toBe(403);
    } finally {
      await handle.close();
    }
  });
});
