import { describe, it, expect, vi } from 'vitest';
import { Agent, MessageRole } from '../agent.js';
import { Sandbox } from '../sandbox.js';
import { tool, ToolRegistry } from '../tool.js';
import type { LanguageModel, GenerateRequest, GenerateResponse } from '../agent.js';

// Mock language model for testing
class MockLanguageModel implements LanguageModel {
  private responses: GenerateResponse[];
  private callIndex = 0;
  public requests: GenerateRequest[] = [];

  constructor(responses: GenerateResponse[]) {
    this.responses = responses;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    this.requests.push(request);
    const response = this.responses[this.callIndex] || this.responses[this.responses.length - 1];
    this.callIndex++;
    return response;
  }
}

describe('Agent', () => {
  it('should create agent with configuration', () => {
    const mockModel = new MockLanguageModel([
      { text: 'Hello!', finishReason: 'stop' }
    ]);

    const agent = new Agent({
      name: 'test-agent',
      model: mockModel,
      instructions: 'You are a helpful assistant',
      modelName: 'test-model',
      temperature: 0.5
    });

    expect(agent.name).toBe('test-agent');
    expect(agent.modelName).toBe('test-model');
    expect(agent.temperature).toBe(0.5);
  });

  it('forwards prompt cache options to model requests', () => {
    const mockModel = new MockLanguageModel([
      { text: 'Cached answer.', finishReason: 'stop' }
    ]);

    const agent = new Agent({
      name: 'cache-agent',
      model: mockModel,
      instructions: 'Stable instructions.',
      modelName: 'anthropic/claude-3-5-haiku-latest',
      cache: { ttl: '1h' },
    });

    const request = (agent as any).buildModelRequest(
      [{ role: 'user', content: 'Use the stable context.' }],
      [],
    ) as GenerateRequest;

    expect(request.config?.cache).toEqual({ enabled: true, ttl: '1h' });
  });

  it('should add standard sandbox tools when sandbox is configured', () => {
    const mockModel = new MockLanguageModel([
      { text: 'Hello!', finishReason: 'stop' }
    ]);

    const agent = new Agent({
      name: 'coder',
      model: mockModel,
      instructions: 'Use the sandbox.',
      sandbox: new Sandbox(),
    });

    const toolNames = Array.from((agent as any).tools.keys());
    expect(toolNames).toEqual(expect.arrayContaining([
      'sandbox_execute_code',
      'sandbox_write_file',
      'sandbox_read_file',
      'sandbox_list_files',
    ]));
  });

  it('should expose sandbox on tool context and close after run', async () => {
    const sandbox = {
      close: vi.fn(async () => {}),
      executeCode: vi.fn(),
      writeFile: vi.fn(),
      readFile: vi.fn(),
      listFiles: vi.fn(),
    } as any;
    const observed: { sandbox?: unknown } = {};
    const inspectSandbox = tool(
      'inspect_sandbox',
      {
        description: 'Inspect sandbox context',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      async (ctx) => {
        observed.sandbox = (ctx as any).sandbox;
        return { hasSandbox: observed.sandbox === sandbox };
      },
    );
    const mockModel = new MockLanguageModel([
      {
        text: 'I will inspect the sandbox.',
        toolCalls: [
          {
            name: 'inspect_sandbox',
            arguments: '{}',
          },
        ],
      },
      { text: 'Sandbox is available.', finishReason: 'stop' },
    ]);

    const agent = new Agent({
      name: 'sandbox-agent',
      model: mockModel,
      instructions: 'Use the sandbox.',
      tools: [inspectSandbox],
      sandbox,
    });
    const context = {
      invocationId: 'invocation-1',
      runId: 'run-1',
      attempt: 0,
      serviceName: 'test',
      runtime: {},
      signal: new AbortController().signal,
      get: vi.fn(async (_key: string, defaultValue?: unknown) => defaultValue),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => false),
      step: vi.fn(async (_name: string, fn: () => unknown) => fn()),
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
      emit: vi.fn(async () => {}),
    } as any;

    const result = await agent.run('Check the sandbox.', context);

    expect(result.output).toBe('Sandbox is available.');
    expect(observed.sandbox).toBe(sandbox);
    expect(sandbox.close).toHaveBeenCalledTimes(1);
  });

  it('should reject unsupported provider prefixes in modelName', () => {
    const mockModel = new MockLanguageModel([
      { text: 'Hello!', finishReason: 'stop' }
    ]);

    expect(() => new Agent({
      name: 'bad-provider-agent',
      model: mockModel,
      instructions: 'Be helpful',
      modelName: 'open/gpt-5-mini',
    })).toThrow("Unsupported model provider 'open'");
  });

  it('should run agent and return output', async () => {
    const mockModel = new MockLanguageModel([
      { text: 'This is my response', finishReason: 'stop' }
    ]);

    const agent = new Agent({
      name: 'simple-agent',
      model: mockModel,
      instructions: 'Be helpful'
    });

    const result = await agent.run('Hello');

    expect(result.output).toBe('This is my response');
    expect(result.toolCalls).toHaveLength(0);
  });

  it('should orchestrate tool calls', async () => {
    ToolRegistry.clear();

    // Create a simple tool
    const calculator = tool(
      'calculator',
      {
        description: 'Performs calculations',
        inputSchema: {
          type: 'object',
          properties: {
            operation: { type: 'string' },
            a: { type: 'number' },
            b: { type: 'number' }
          },
          required: ['operation', 'a', 'b']
        }
      },
      async (ctx, args) => {
        const { operation, a, b } = args;
        if (operation === 'add') return a + b;
        if (operation === 'multiply') return a * b;
        return 0;
      }
    );

    // Mock model that calls tool then provides answer
    const mockModel = new MockLanguageModel([
      // First response: call tool
      {
        text: "I'll calculate that",
        toolCalls: [
          {
            name: 'calculator',
            arguments: JSON.stringify({ operation: 'add', a: 10, b: 5 })
          }
        ]
      },
      // Second response: final answer
      {
        text: 'The result is 15',
        finishReason: 'stop'
      }
    ]);

    const agent = new Agent({
      name: 'calculator-agent',
      model: mockModel,
      instructions: 'You can use a calculator',
      tools: [calculator]
    });

    const result = await agent.run('What is 10 + 5?');

    expect(result.output).toBe('The result is 15');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('calculator');
  });

  it('should record built-in tool calls without local dispatch', async () => {
    const mockModel = new MockLanguageModel([
      {
        text: 'Final answer based on search results',
        toolCalls: [
          {
            id: 'ws_1',
            name: 'web_search_preview',
            arguments: '{}'
          }
        ]
      }
    ]);

    const agent = new Agent({
      name: 'builtin-agent',
      model: mockModel,
      instructions: 'Use provider-hosted search.',
      builtInTools: ['web_search']
    });

    const result = await agent.run('Search for something.');

    expect(mockModel.requests[0].config?.builtInTools).toEqual(['web_search']);
    expect(result.output).toBe('Final answer based on search results');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('web_search_preview');
    expect(result.toolCalls[0].builtIn).toBe(true);
  });

  it('should dispatch only user tools when response mixes built-in and user calls', async () => {
    ToolRegistry.clear();

    const saveNote = tool(
      'save_note',
      {
        description: 'Save a note',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' }
          },
          required: ['text']
        }
      },
      async (ctx, args) => `saved:${args.text}`
    );

    const mockModel = new MockLanguageModel([
      {
        text: 'I will search and save.',
        toolCalls: [
          {
            id: 'ws_1',
            name: 'web_search_preview',
            arguments: '{}'
          },
          {
            id: 'save_1',
            name: 'save_note',
            arguments: JSON.stringify({ text: 'hello' })
          }
        ]
      },
      {
        text: 'Done.',
        finishReason: 'stop'
      }
    ]);

    const agent = new Agent({
      name: 'mixed-builtin-agent',
      model: mockModel,
      instructions: 'Search and save.',
      tools: [saveNote],
      builtInTools: ['web_search']
    });

    const result = await agent.run('Search and save a note.');

    expect(result.output).toBe('Done.');
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls.find(tc => tc.name === 'web_search_preview')?.builtIn).toBe(true);
    expect(result.toolCalls.find(tc => tc.name === 'save_note')?.builtIn).toBeUndefined();
  });

  it('should handle multi-turn chat', async () => {
    const mockModel = new MockLanguageModel([
      { text: 'Response 1', finishReason: 'stop' },
      { text: 'Response 2', finishReason: 'stop' }
    ]);

    const agent = new Agent({
      name: 'chat-agent',
      model: mockModel,
      instructions: 'Be conversational'
    });

    let messages: any[] = [];
    let response: string;

    [response, messages] = await agent.chat('First message', messages);
    expect(response).toBe('Response 1');
    expect(messages).toHaveLength(2); // user + assistant

    [response, messages] = await agent.chat('Second message', messages);
    expect(response).toBe('Response 2');
    expect(messages).toHaveLength(4); // 2 previous + 2 new
  });

  it('should respect max iterations limit', async () => {
    // Mock model that always calls tools (infinite loop scenario)
    const mockModel = new MockLanguageModel([
      {
        text: 'Calling tool',
        toolCalls: [
          {
            name: 'test_tool',
            arguments: '{}'
          }
        ]
      }
    ]);

    const testTool = tool(
      'test_tool',
      {
        description: 'Test tool',
        inputSchema: { type: 'object', properties: {}, required: [] }
      },
      async (ctx, args) => 'result'
    );

    const agent = new Agent({
      name: 'loop-agent',
      model: mockModel,
      instructions: 'Test',
      tools: [testTool],
      maxIterations: 3
    });

    const result = await agent.run('Test');

    // Should stop after max iterations
    expect(result.toolCalls.length).toBeLessThanOrEqual(3);
  });
});
