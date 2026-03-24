/**
 * Example: Multi-agent orchestration
 *
 * Demonstrates different patterns for coordinating multiple agents:
 * 1. Agents as tools (coordinator pattern)
 * 2. Explicit handoffs (routing pattern)
 * 3. Streaming multi-agent execution
 */

import { Agent, handoff, LM, tool } from '../src/index.js';
import type { LanguageModel, GenerateRequest, GenerateResponse, Message, ToolCall, TokenUsage } from '../src/index.js';

// ─── Mock LLM for demonstration ────────────────────────────────────

class MockModel implements LanguageModel {
  private responseMap: Map<string, string>;

  constructor(responses: Record<string, string>) {
    this.responseMap = new Map(Object.entries(responses));
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const lastMsg = request.messages[request.messages.length - 1];
    const prompt = typeof lastMsg.content === 'string' ? lastMsg.content : '';

    // Check for tool calls
    if (request.tools && request.tools.length > 0) {
      // If the prompt mentions routing, call a transfer tool
      for (const t of request.tools) {
        if (t.name.startsWith('transfer_to_') && prompt.toLowerCase().includes('technical')) {
          return {
            content: '',
            toolCalls: [{ id: `tc_${Date.now()}`, name: t.name, arguments: {} }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          };
        }
      }
    }

    // Find matching response
    for (const [key, response] of this.responseMap) {
      if (prompt.toLowerCase().includes(key.toLowerCase())) {
        return {
          content: response,
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        };
      }
    }

    return {
      content: 'I can help with that.',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }
}

// ─── 1. Agents as tools (coordinator pattern) ───────────────────────

async function coordinatorPattern() {
  console.log('=== Coordinator pattern (agents as tools) ===\n');

  const researchModel = new MockModel({
    'research': 'Based on my research, AI adoption grew 35% in 2024.',
    'ai': 'AI trends include: multimodal models, agents, and on-device inference.',
  });

  const analysisModel = new MockModel({
    'analyze': 'Analysis: The 35% growth indicates strong enterprise adoption.',
    'data': 'Data shows correlation between AI investment and productivity gains.',
  });

  const researcher = new Agent({
    name: 'researcher',
    model: researchModel,
    instructions: 'You research topics and provide factual summaries.',
  });

  const analyst = new Agent({
    name: 'analyst',
    model: analysisModel,
    instructions: 'You analyze data and provide insights.',
  });

  const coordinatorModel = new MockModel({
    '': 'Based on the research and analysis, AI is growing rapidly with strong enterprise adoption.',
  });

  // The coordinator uses other agents as tools
  const coordinator = new Agent({
    name: 'coordinator',
    model: coordinatorModel,
    tools: [
      tool('research', {
        description: 'Delegate research tasks',
        handler: async (_ctx, args: any) => {
          const result = await researcher.run(args.topic || 'research AI');
          return result.output;
        },
      }),
      tool('analyze', {
        description: 'Delegate analysis tasks',
        handler: async (_ctx, args: any) => {
          const result = await analyst.run(args.data || 'analyze data');
          return result.output;
        },
      }),
    ],
    instructions: 'Coordinate research and analysis tasks.',
  });

  const result = await coordinator.run('Research AI trends and analyze the findings');
  console.log('Coordinator output:', result.output);
  console.log();
}

// ─── 2. Explicit handoffs (routing pattern) ─────────────────────────

async function handoffPattern() {
  console.log('=== Handoff pattern (routing) ===\n');

  const technicalModel = new MockModel({
    '': 'To implement OAuth2, use the authorization code flow with PKCE. Here are the steps...',
  });

  const businessModel = new MockModel({
    '': 'Our enterprise pricing starts at $999/month with custom SLAs and dedicated support.',
  });

  const technicalAgent = new Agent({
    name: 'technical-support',
    model: technicalModel,
    instructions: 'You answer technical questions about APIs and implementation.',
  });

  const businessAgent = new Agent({
    name: 'business-support',
    model: businessModel,
    instructions: 'You handle business inquiries, pricing, and enterprise deals.',
  });

  const triageModel = new MockModel({
    'oauth': '', // Empty — will trigger tool call via MockModel
    'technical': '',
    '': 'Let me help route your question.',
  });

  const triage = new Agent({
    name: 'triage',
    model: triageModel,
    instructions: 'Route questions to the right specialist.',
    handoffs: [
      handoff(technicalAgent, 'Transfer to technical support for API and implementation questions'),
      handoff(businessAgent, 'Transfer to business support for pricing and enterprise inquiries'),
    ],
  });

  // This should be routed to the technical agent
  const result = await triage.run('How do I implement OAuth2 in my technical app?');
  console.log('Final output:', result.output);
  console.log('Handed off to:', result.handoffTo || 'none');
  console.log();
}

// ─── 3. Streaming multi-agent execution ─────────────────────────────

async function streamingMultiAgent() {
  console.log('=== Streaming multi-agent execution ===\n');

  const model = new MockModel({
    '': 'Here is my analysis of the situation.',
  });

  const agent = new Agent({
    name: 'streaming-agent',
    model,
    instructions: 'Provide detailed analysis.',
  });

  // Stream events from agent execution
  for await (const event of agent.stream('Analyze the current market trends')) {
    if ('eventType' in event) {
      console.log(`Event: ${event.eventType}`);
    } else {
      // AgentResult
      console.log('Final result:', event.output);
    }
  }
}

// ─── Run examples ───────────────────────────────────────────────────

async function main() {
  await coordinatorPattern();
  await handoffPattern();
  await streamingMultiAgent();
}

main().catch(console.error);
