/**
 * Example: Tool component usage
 *
 * Demonstrates how to create and use tools for agents
 */

import { tool, ToolRegistry, ContextImpl } from '../src/index.js';

// Define a search tool
const searchWeb = tool(
  'search_web',
  {
    description: 'Search the web for information',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        maxResults: { type: 'integer', description: 'Maximum number of results' }
      },
      required: ['query']
    }
  },
  async (ctx, args) => {
    const { query, maxResults = 10 } = args;
    ctx.logger.info(`Searching for: ${query} (max ${maxResults} results)`);

    // Simulate search results
    return [
      { title: 'Result 1', url: 'https://example.com/1', snippet: 'First result' },
      { title: 'Result 2', url: 'https://example.com/2', snippet: 'Second result' }
    ].slice(0, maxResults);
  }
);

// Define a calculator tool
const calculate = tool(
  'calculate',
  {
    description: 'Perform basic arithmetic calculations',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', description: 'Operation: add, subtract, multiply, divide' },
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
      case 'add':
        return a + b;
      case 'subtract':
        return a - b;
      case 'multiply':
        return a * b;
      case 'divide':
        if (b === 0) throw new Error('Division by zero');
        return a / b;
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  }
);

async function main() {
  console.log('=== Tool Example ===\n');

  // Create context
  const ctx = new ContextImpl('inv-1', 'run-1', 0, 'tool-example');

  // Use search tool
  console.log('1. Searching the web:');
  const searchResults = await searchWeb(ctx, { query: 'TypeScript SDK', maxResults: 2 });
  console.log('Results:', JSON.stringify(searchResults, null, 2));

  console.log('\n2. Performing calculations:');
  const sum = await calculate(ctx, { operation: 'add', a: 10, b: 5 });
  console.log(`10 + 5 = ${sum}`);

  const product = await calculate(ctx, { operation: 'multiply', a: 7, b: 8 });
  console.log(`7 * 8 = ${product}`);

  console.log('\n3. Tool registry:');
  console.log('Registered tools:', ToolRegistry.listNames());

  // Get tool schema
  const searchTool = ToolRegistry.get('search_web');
  if (searchTool) {
    console.log('\nSearch tool schema:', JSON.stringify(searchTool.getSchema(), null, 2));
  }
}

main().catch(console.error);
