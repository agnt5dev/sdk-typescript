import { describe, it, expect, beforeEach } from 'vitest';
import { Agent, callbackOverride } from '../agent.js';
import { tool, ToolRegistry } from '../tool.js';
import type { GenerateRequest, GenerateResponse, LanguageModel } from '../agent.js';

class MockLanguageModel implements LanguageModel {
  public callCount = 0;
  public requests: GenerateRequest[] = [];

  constructor(private responses: GenerateResponse[]) {}

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const response = this.responses[this.callCount] || this.responses[this.responses.length - 1];
    this.callCount++;
    return response;
  }
}

describe('Agent callbacks', () => {
  beforeEach(() => {
    ToolRegistry.clear();
  });

  it('beforeAgent short-circuits model execution', async () => {
    const model = new MockLanguageModel([{ text: 'provider response' }]);
    const agent = new Agent({
      name: 'callback-agent',
      model,
      instructions: 'Be helpful',
      callbacks: {
        beforeAgent: () => 'blocked by callback',
      },
    });

    const result = await agent.run('hello');

    expect(result.output).toBe('blocked by callback');
    expect(model.callCount).toBe(0);
  });

  it('afterAgent replaces final output', async () => {
    const model = new MockLanguageModel([{ text: 'provider response' }]);
    const agent = new Agent({
      name: 'callback-agent',
      model,
      instructions: 'Be helpful',
      callbacks: {
        afterAgent: () => 'rewritten output',
      },
    });

    const result = await agent.run('hello');

    expect(result.output).toBe('rewritten output');
    expect(model.callCount).toBe(1);
  });

  it('beforeModel short-circuits provider call', async () => {
    const model = new MockLanguageModel([{ text: 'provider response' }]);
    const agent = new Agent({
      name: 'callback-agent',
      model,
      instructions: 'Be helpful',
      callbacks: {
        beforeModel: () => ({ text: 'cached response' }),
      },
    });

    const result = await agent.run('hello');

    expect(result.output).toBe('cached response');
    expect(model.callCount).toBe(0);
  });

  it('afterModel replaces provider response', async () => {
    const model = new MockLanguageModel([{ text: 'provider response' }]);
    const agent = new Agent({
      name: 'callback-agent',
      model,
      instructions: 'Be helpful',
      callbacks: {
        afterModel: () => ({ text: 'rewritten model' }),
      },
    });

    const result = await agent.run('hello');

    expect(result.output).toBe('rewritten model');
    expect(model.callCount).toBe(1);
  });

  it('beforeTool short-circuits tool handler', async () => {
    let toolCalled = false;
    const lookup = tool(
      'lookup',
      {
        description: 'Lookup a value',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
      async (_ctx, args) => {
        toolCalled = true;
        return `real ${args.query}`;
      },
    );
    const model = new MockLanguageModel([
      {
        text: 'using tool',
        toolCalls: [{ id: 'call-1', name: 'lookup', arguments: JSON.stringify({ query: 'x' }) }],
      },
      { text: 'done' },
    ]);
    const agent = new Agent({
      name: 'callback-agent',
      model,
      instructions: 'Use tools',
      tools: [lookup],
      callbacks: {
        beforeTool: () => 'cached tool result',
      },
    });

    const result = await agent.run('lookup x');

    expect(result.output).toBe('done');
    expect(toolCalled).toBe(false);
    expect(model.requests[1].messages.at(-1)?.content).toContain('cached tool result');
  });

  it('afterTool rewrites tool result', async () => {
    const lookup = tool(
      'lookup',
      {
        description: 'Lookup a value',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
      async (_ctx, args) => `real ${args.query}`,
    );
    const model = new MockLanguageModel([
      {
        text: 'using tool',
        toolCalls: [{ id: 'call-1', name: 'lookup', arguments: JSON.stringify({ query: 'x' }) }],
      },
      { text: 'done' },
    ]);
    const agent = new Agent({
      name: 'callback-agent',
      model,
      instructions: 'Use tools',
      tools: [lookup],
      callbacks: {
        afterTool: () => callbackOverride('rewritten tool result'),
      },
    });

    const result = await agent.run('lookup x');

    expect(result.output).toBe('done');
    expect(model.requests[1].messages.at(-1)?.content).toContain('rewritten tool result');
  });
});
