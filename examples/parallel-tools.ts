/**
 * Example: Parallel tool execution
 *
 * Demonstrates agents executing multiple tools in parallel,
 * and workflow patterns for concurrent operations.
 */

import { Agent, tool, LM } from '../src/index.js';
import type { Context } from '../src/types.js';

// ─── Define tools that can run in parallel ──────────────────────────

const searchWeb = tool('search_web', {
  description: 'Search the web for information',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
    },
    required: ['query'],
  },
  handler: async (_ctx: Context, args: { query: string }) => {
    // Simulated search
    await new Promise(resolve => setTimeout(resolve, 100));
    return `Search results for "${args.query}": [Result 1, Result 2, Result 3]`;
  },
});

const getWeather = tool('get_weather', {
  description: 'Get current weather for a location',
  inputSchema: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'City name' },
    },
    required: ['location'],
  },
  handler: async (_ctx: Context, args: { location: string }) => {
    await new Promise(resolve => setTimeout(resolve, 80));
    return `Weather in ${args.location}: 72°F, Sunny`;
  },
});

const getNews = tool('get_news', {
  description: 'Get latest news headlines',
  inputSchema: {
    type: 'object',
    properties: {
      category: { type: 'string', description: 'News category' },
    },
    required: ['category'],
  },
  handler: async (_ctx: Context, args: { category: string }) => {
    await new Promise(resolve => setTimeout(resolve, 120));
    return `Latest ${args.category} news: [Headline 1, Headline 2]`;
  },
});

// ─── Agent with parallel tool calls ─────────────────────────────────

async function agentParallelTools() {
  const model = new LM({ provider: 'openai', model: 'gpt-4o-mini' });

  const agent = new Agent({
    name: 'research-assistant',
    model,
    tools: [searchWeb, getWeather, getNews],
    instructions: `You are a research assistant. When asked for a briefing,
      use ALL available tools in a single response to gather information efficiently.
      The tools will execute in parallel.`,
  });

  // The agent should call multiple tools at once
  const result = await agent.run('Give me a morning briefing for San Francisco');
  console.log('Agent output:', result.output);
  console.log('Tool calls made:', result.toolCalls?.length || 0);
}

// ─── Workflow with parallel execution ───────────────────────────────

import { workflow, parallel, gather } from '../src/index.js';

const parallelDataPipeline = workflow('parallel-pipeline', {
  description: 'Process data from multiple sources in parallel',
  handler: async (ctx, input: { query: string }) => {
    // Run three data fetches in parallel
    const results = await gather(
      ctx.step('fetch-db', async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return { source: 'database', count: 42 };
      }),
      ctx.step('fetch-api', async () => {
        await new Promise(resolve => setTimeout(resolve, 150));
        return { source: 'api', count: 17 };
      }),
      ctx.step('fetch-cache', async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return { source: 'cache', count: 99 };
      }),
    );

    // Aggregate results
    const total = results.reduce((sum, r) => sum + (r as any).count, 0);
    return { results, totalCount: total };
  },
});

async function main() {
  console.log('=== Parallel tools example ===\n');
  console.log('(Agent example requires OPENAI_API_KEY)');
  // await agentParallelTools();
}

main().catch(console.error);
