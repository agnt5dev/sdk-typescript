import { Readable } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
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
    const echo = new Tool(
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
      tools: { echo },
      agents: { research_agent: agent },
      workflows: { summarize_topic: summarizeTopic },
    });

    const listed = await call(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });

    const toolNames = new Set((listed.result.tools as Array<{ name: string }>).map(t => t.name));
    expect(toolNames.has('echo')).toBe(true);
    expect(toolNames.has('research_agent')).toBe(true);
    expect(toolNames.has('summarize_topic')).toBe(true);

    const echoResponse = await call(server, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'echo',
        arguments: { message: 'hello' },
      },
    });
    expect(echoResponse.result.content[0].text).toBe('echo:hello');

    const workflowResponse = await call(server, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'summarize_topic',
        arguments: { topic: 'mcp' },
      },
    });
    expect(workflowResponse.result.content[0].text).toContain('"summary":"done"');

    const agentResponse = await call(server, {
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

    const promptsResponse = await call(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'prompts/list',
      params: {},
    });
    expect(promptsResponse.result.prompts[0].name).toBe('research_brief');

    const promptResponse = await call(server, {
      jsonrpc: '2.0',
      id: 2,
      method: 'prompts/get',
      params: {
        name: 'research_brief',
        arguments: { topic: 'AGNT5' },
      },
    });
    expect(promptResponse.result.messages[0].content.text).toBe('Research AGNT5');

    const resourcesResponse = await call(server, {
      jsonrpc: '2.0',
      id: 3,
      method: 'resources/list',
      params: {},
    });
    expect(resourcesResponse.result.resources[0].uri).toBe('docs://handbook');

    const resourceResponse = await call(server, {
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/read',
      params: { uri: 'docs://handbook' },
    });
    expect(resourceResponse.result.contents[0].text).toBe('# Handbook');
  });

  it('does not answer notifications or client responses over stdio', async () => {
    const server = new MCPServer({ id: 'test-mcp' });
    const replies = await serveStdio(
      server,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
      { jsonrpc: '2.0', method: 'no/such/notification' },
      { jsonrpc: '2.0', id: 'srv-1', result: {} },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    );
    expect(replies.map(reply => reply.id)).toEqual([1, 2]);
    expect(replies[0].result.serverInfo.name).toBe('test-mcp');
    expect(replies[1].result).toEqual({});
  });

  it('answers each malformed or unknown request with its JSON-RPC code over stdio', async () => {
    const server = new MCPServer({ id: 'test-mcp', tools: { echo: echoTool() } });
    const replies = await serveStdio(
      server,
      { jsonrpc: '2.0', id: 1, method: 'nope' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope' } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: 1 } },
      { id: 4, method: 'ping' },
      '{not json',
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: { message: 'hi' } } },
    );
    expect(replies.map(reply => [reply.id, reply.error?.code ?? null])).toEqual([
      [1, -32601],
      [2, -32602],
      [3, -32602],
      [4, -32600],
      [null, -32700],
      [5, null],
    ]);
    expect(replies[5].result.content[0].text).toBe('echo:hi');
  });

  it('frames stdio replies as JSON lines and accepts CRLF input', async () => {
    const server = new MCPServer({ id: 'test-mcp' });
    const output = await runStdio(server, '{"jsonrpc":"2.0","id":1,"method":"ping"}\r\n\n');
    expect(output).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    expect(output).not.toContain('Content-Length');
  });

  it('returns -32601 for an unknown method', async () => {
    const server = new MCPServer({ id: 'test-mcp' });
    const response = await call(server, { jsonrpc: '2.0', id: 1, method: 'tools/nope' });
    expect(response.id).toBe(1);
    expect(response.error.code).toBe(-32601);
  });

  it('returns -32602 for an unknown tool', async () => {
    const server = new MCPServer({ id: 'test-mcp', tools: { echo: echoTool() } });
    const response = await call(server, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope', arguments: {} },
    });
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain('nope');
  });

  it.each([
    [{ name: 'echo', arguments: 'hello' }],
    [{ name: 'echo', arguments: ['hello'] }],
    [{ arguments: { message: 'hello' } }],
    [{ name: 7, arguments: {} }],
  ])('returns -32602 for malformed tool call params %j', async params => {
    const server = new MCPServer({ id: 'test-mcp', tools: { echo: echoTool() } });
    const response = await call(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params });
    expect(response.error.code).toBe(-32602);
  });

  it('returns -32602 when params is not an object', async () => {
    const server = new MCPServer({ id: 'test-mcp' });
    const response = await call(server, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: [1] });
    expect(response.error.code).toBe(-32602);
  });

  it('reports a failing tool as a tool error, not a protocol error', async () => {
    const explode = new Tool('explode', 'Always fails', async () => {
      throw new Error('boom');
    });
    const server = new MCPServer({ id: 'test-mcp', tools: { explode } });
    const response = await call(server, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'explode', arguments: {} },
    });
    expect(response.error).toBeUndefined();
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('boom');
  });

  it('returns -32602 for an unknown prompt and -32002 for an unknown resource', async () => {
    const server = new MCPServer({ id: 'test-mcp' });
    const prompt = await call(server, { jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'nope' } });
    expect(prompt.error.code).toBe(-32602);
    const resource = await call(server, {
      jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'docs://nope' },
    });
    expect(resource.error.code).toBe(-32002);
  });

  it.each([
    [{ id: 1, method: 'ping' }],
    [{ jsonrpc: '1.0', id: 1, method: 'ping' }],
    [{ jsonrpc: 2.0, id: 1, method: 'ping' }],
  ])('returns -32600 for a request without "jsonrpc": "2.0" %j', async request => {
    const server = new MCPServer({ id: 'test-mcp' });
    const response = await call(server, request);
    expect(response.id).toBe(1);
    expect(response.error.code).toBe(-32600);
  });

  it.each([
    [[{ jsonrpc: '2.0', id: 1, method: 'ping' }]],
    ['ping'],
    [{ jsonrpc: '2.0', id: null, method: 'ping' }],
    [{ jsonrpc: '2.0', id: 1.5, method: 'ping' }],
    [{ jsonrpc: '2.0', id: 1 }],
    [{ jsonrpc: '2.0', id: 1, method: 5 }],
  ])('returns -32600 for a malformed request %j', async request => {
    const server = new MCPServer({ id: 'test-mcp' });
    const response = await call(server, request);
    expect(response.error.code).toBe(-32600);
  });

  it('no longer has the POST-only HTTP transport', () => {
    const server = new MCPServer({ id: 'test-mcp' }) as any;
    expect(server.runHTTP).toBeUndefined();
    expect(server.startHTTP).toBeUndefined();
  });
});

function echoTool(): Tool {
  return new Tool('echo', 'Echo a message', async (_ctx, args: { message: string }) => `echo:${args.message}`);
}

async function call(server: MCPServer, request: unknown): Promise<any> {
  const response = await server.dispatch(request);
  expect(response).toBeDefined();
  return response!;
}

/** Run `runStdio` over the given input and return what it writes. */
async function runStdio(server: MCPServer, input: string): Promise<string> {
  const stdin = vi
    .spyOn(process, 'stdin', 'get')
    .mockReturnValue(Readable.from([Buffer.from(input, 'utf8')]) as any);
  const writes: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
    writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    return true;
  }) as any);
  try {
    await server.runStdio();
  } finally {
    stdin.mockRestore();
    stdout.mockRestore();
  }
  return writes.join('');
}

async function serveStdio(server: MCPServer, ...messages: unknown[]): Promise<any[]> {
  const input =
    messages.map(message => (typeof message === 'string' ? message : JSON.stringify(message))).join('\n') + '\n';
  const output = await runStdio(server, input);
  return output.split('\n').filter(Boolean).map(line => JSON.parse(line));
}
