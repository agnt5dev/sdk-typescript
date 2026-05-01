import { describe, it, expect } from 'vitest';
import { Agent, MessageRole } from '../agent.js';
import { tool, ToolRegistry } from '../tool.js';
import type { LanguageModel, GenerateRequest, GenerateResponse } from '../agent.js';

// Mock language model for testing
class MockLanguageModel implements LanguageModel {
  private responses: GenerateResponse[];
  private callIndex = 0;

  constructor(responses: GenerateResponse[]) {
    this.responses = responses;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
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
