/**
 * Example: AGNT5 MCP Server
 *
 * Expose AGNT5 tools, agents, workflows, prompts, and resources as an MCP server.
 */

import { Agent, MCPServer, Prompt, Resource, Tool, workflow } from '../src/index.js';
import type { GenerateRequest, GenerateResponse, LanguageModel } from '../src/index.js';

class DemoLanguageModel implements LanguageModel {
  async generate(_request: GenerateRequest): Promise<GenerateResponse> {
    return { text: 'This is a demo agent response.', finishReason: 'stop' };
  }
}

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
  return { topic: input.topic, summary: 'demo-summary' };
});

const server = new MCPServer({
  id: 'demo-mcp',
  name: 'Demo MCP Server',
  version: '1.0.0',
  tools: { echo: echoTool },
  agents: {
    research_agent: new Agent({
      name: 'research_agent',
      model: new DemoLanguageModel(),
      instructions: 'You are a helpful demo agent.',
    }),
  },
  workflows: { summarize_topic: summarizeTopic },
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
      name: 'Demo Handbook',
      mimeType: 'text/markdown',
      read: async () => '# Demo Handbook',
    }),
  },
});

server.runStdio().catch(error => {
  console.error(error);
  process.exit(1);
});
