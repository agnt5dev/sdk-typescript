/**
 * Example: Agent component usage
 *
 * Demonstrates LLM-powered agents with tool orchestration
 * Note: This is a mock example without real LLM integration
 */

import { Agent, tool, ToolRegistry, ContextImpl } from '../src/index.js';
import type { LanguageModel, GenerateRequest, GenerateResponse } from '../src/index.js';

// Mock Language Model for demonstration
class MockLanguageModel implements LanguageModel {
  private callCount = 0;

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    this.callCount++;

    console.log(`\n[LLM Call ${this.callCount}]`);
    console.log('System:', request.systemPrompt);
    console.log('Messages:', request.messages.map(m => `${m.role}: ${m.content}`).join('\n'));

    // Simulate agent behavior based on call count
    if (this.callCount === 1) {
      // First call: agent decides to use search tool
      return {
        text: "I'll search for information about TypeScript",
        toolCalls: [
          {
            name: 'search_web',
            arguments: JSON.stringify({ query: 'TypeScript features', maxResults: 3 })
          }
        ]
      };
    } else if (this.callCount === 2) {
      // Second call: agent uses calculator
      return {
        text: "Let me calculate that for you",
        toolCalls: [
          {
            name: 'calculate',
            arguments: JSON.stringify({ operation: 'multiply', a: 25, b: 4 })
          }
        ]
      };
    } else {
      // Final call: agent provides answer
      return {
        text: "Based on the search results, TypeScript is a strongly-typed programming language that builds on JavaScript. The calculation shows 25 × 4 = 100. TypeScript provides type safety and better tooling for large-scale applications.",
        finishReason: 'stop'
      };
    }
  }
}

// Define tools for the agent
const searchTool = tool(
  'search_web',
  {
    description: 'Search the web for information',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        maxResults: { type: 'integer', description: 'Max results to return' }
      },
      required: ['query']
    }
  },
  async (ctx, args) => {
    const { query, maxResults = 10 } = args;
    ctx.logger.info(`Searching: ${query}`);

    // Mock search results
    return [
      {
        title: 'TypeScript: JavaScript with syntax for types',
        url: 'https://www.typescriptlang.org/',
        snippet: 'TypeScript is a strongly typed programming language that builds on JavaScript'
      },
      {
        title: 'TypeScript Features',
        url: 'https://example.com/ts-features',
        snippet: 'Static typing, interfaces, classes, and modern JavaScript features'
      }
    ].slice(0, maxResults);
  }
);

const calculatorTool = tool(
  'calculate',
  {
    description: 'Perform arithmetic calculations',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', description: 'add, subtract, multiply, or divide' },
        a: { type: 'number', description: 'First number' },
        b: { type: 'number', description: 'Second number' }
      },
      required: ['operation', 'a', 'b']
    }
  },
  async (ctx, args) => {
    const { operation, a, b } = args;
    ctx.logger.info(`Calculating: ${a} ${operation} ${b}`);

    switch (operation) {
      case 'add': return a + b;
      case 'subtract': return a - b;
      case 'multiply': return a * b;
      case 'divide': return b !== 0 ? a / b : null;
      default: throw new Error(`Unknown operation: ${operation}`);
    }
  }
);

async function main() {
  console.log('=== Agent Example ===');

  // Create agent with tools
  const agent = new Agent({
    name: 'research-assistant',
    model: new MockLanguageModel(),
    instructions: 'You are a helpful research assistant. Use tools to gather information and perform calculations.',
    tools: [searchTool, calculatorTool],
    modelName: 'mock-model',
    temperature: 0.7,
    maxIterations: 5
  });

  console.log('\n1. Agent with Tool Orchestration:');
  const result = await agent.run('What is TypeScript and calculate 25 times 4?');

  console.log('\n=== Agent Result ===');
  console.log('Output:', result.output);
  console.log('\nTool Calls:');
  result.toolCalls.forEach((tc, i) => {
    console.log(`  ${i + 1}. ${tc.name} (iteration ${tc.iteration})`);
    console.log(`     Arguments: ${tc.arguments}`);
  });

  console.log('\n2. Simple Chat (without tools):');
  let messages: any[] = [];
  let response: string;

  // Mock simple chat response
  const mockChatModel = new MockLanguageModel();
  mockChatModel.generate = async (req) => ({
    text: "Hello! I'm your research assistant. How can I help you today?",
    finishReason: 'stop'
  });

  const chatAgent = new Agent({
    name: 'chat-agent',
    model: mockChatModel,
    instructions: 'You are a friendly assistant.',
    modelName: 'mock-model'
  });

  [response, messages] = await chatAgent.chat('Hello!', []);
  console.log('User: Hello!');
  console.log('Agent:', response);

  console.log('\n3. Tool Registry:');
  console.log('Available tools:', ToolRegistry.listNames());
}

main().catch(console.error);
