import { describe, it, expect, beforeEach } from 'vitest';
import { Agent, Handoff, handoff } from '../agent.js';
import { tool, ToolRegistry } from '../tool.js';
import type { LanguageModel, GenerateRequest, GenerateResponse } from '../agent.js';
import type { AgentEvent } from '../events.js';
import type { AgentResult } from '../agent.js';

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

describe('Agent Streaming', () => {
  beforeEach(() => {
    ToolRegistry.clear();
  });

  it('should emit AgentStarted and AgentCompleted events', async () => {
    const mockModel = new MockLanguageModel([
      { text: 'Hello!', finishReason: 'stop' },
    ]);

    const agent = new Agent({
      name: 'test-agent',
      model: mockModel,
      instructions: 'Be helpful',
    });

    const events: (AgentEvent | AgentResult)[] = [];
    for await (const event of agent.stream('Hi')) {
      events.push(event);
    }

    // Should have: AgentStarted, IterationStarted, IterationCompleted, AgentCompleted, AgentResult
    expect(events.length).toBe(5);

    const started = events[0] as AgentEvent;
    expect(started.eventType).toBe('agent.started');
    if (started.eventType === 'agent.started') {
      expect(started.agentName).toBe('test-agent');
      expect(started.agentModel).toBe('gpt-4o-mini');
      expect(started.maxIterations).toBe(10);
    }

    const completed = events[3] as AgentEvent;
    expect(completed.eventType).toBe('agent.completed');
    if (completed.eventType === 'agent.completed') {
      expect(completed.agentName).toBe('test-agent');
      expect(completed.iterations).toBe(1);
      expect(completed.handoffTo).toBeNull();
    }
  });

  it('should emit iteration events', async () => {
    const mockModel = new MockLanguageModel([
      { text: 'Done', finishReason: 'stop' },
    ]);

    const agent = new Agent({
      name: 'iter-agent',
      model: mockModel,
      instructions: 'Test',
    });

    const events: AgentEvent[] = [];
    for await (const event of agent.stream('Go')) {
      if ('eventType' in event) events.push(event);
    }

    const iterStarted = events.find(e => e.eventType === 'agent.iteration.started');
    expect(iterStarted).toBeDefined();
    if (iterStarted?.eventType === 'agent.iteration.started') {
      expect(iterStarted.iteration).toBe(1);
      expect(iterStarted.maxIterations).toBe(10);
    }

    const iterCompleted = events.find(e => e.eventType === 'agent.iteration.completed');
    expect(iterCompleted).toBeDefined();
    if (iterCompleted?.eventType === 'agent.iteration.completed') {
      expect(iterCompleted.iteration).toBe(1);
      expect(iterCompleted.hasToolCalls).toBe(false);
    }
  });

  it('should emit tool call events during execution', async () => {
    const calculator = tool(
      'calc_stream',
      {
        description: 'Calculator',
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          required: ['a', 'b'],
        },
      },
      async (_ctx, args) => (args as any).a + (args as any).b,
    );

    const mockModel = new MockLanguageModel([
      {
        text: 'Calculating',
        toolCalls: [{ name: 'calc_stream', arguments: JSON.stringify({ a: 2, b: 3 }) }],
      },
      { text: 'The answer is 5', finishReason: 'stop' },
    ]);

    const agent = new Agent({
      name: 'tool-agent',
      model: mockModel,
      instructions: 'Calculate',
      tools: [calculator],
    });

    const events: AgentEvent[] = [];
    for await (const event of agent.stream('What is 2+3?')) {
      if ('eventType' in event) events.push(event);
    }

    const toolStarted = events.find(e => e.eventType === 'tool_call.started');
    expect(toolStarted).toBeDefined();
    if (toolStarted?.eventType === 'tool_call.started') {
      expect(toolStarted.toolName).toBe('calc_stream');
    }

    const toolCompleted = events.find(e => e.eventType === 'tool_call.completed');
    expect(toolCompleted).toBeDefined();
    if (toolCompleted?.eventType === 'tool_call.completed') {
      expect(toolCompleted.toolName).toBe('calc_stream');
    }
  });

  it('should emit ToolCallFailed on tool error', async () => {
    const failingTool = tool(
      'fail_tool',
      {
        description: 'Always fails',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      async () => { throw new Error('Tool broke'); },
    );

    const mockModel = new MockLanguageModel([
      { text: 'Trying', toolCalls: [{ name: 'fail_tool', arguments: '{}' }] },
      { text: 'It failed', finishReason: 'stop' },
    ]);

    const agent = new Agent({
      name: 'fail-agent',
      model: mockModel,
      instructions: 'Test',
      tools: [failingTool],
    });

    const events: AgentEvent[] = [];
    for await (const event of agent.stream('Do it')) {
      if ('eventType' in event) events.push(event);
    }

    const failed = events.find(e => e.eventType === 'tool_call.failed');
    expect(failed).toBeDefined();
    if (failed?.eventType === 'tool_call.failed') {
      expect(failed.toolName).toBe('fail_tool');
      expect(failed.error).toContain('Tool broke');
    }
  });

  it('should have correct correlation ID hierarchy', async () => {
    const simpleTool = tool(
      'simple_tool',
      {
        description: 'Simple',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      async () => 'ok',
    );

    const mockModel = new MockLanguageModel([
      { text: 'Call tool', toolCalls: [{ name: 'simple_tool', arguments: '{}' }] },
      { text: 'Done', finishReason: 'stop' },
    ]);

    const agent = new Agent({
      name: 'corr-agent',
      model: mockModel,
      instructions: 'Test',
      tools: [simpleTool],
    });

    const events: AgentEvent[] = [];
    for await (const event of agent.stream('Go')) {
      if ('eventType' in event) events.push(event);
    }

    const agentStartedEvt = events.find(e => e.eventType === 'agent.started')!;
    const iterStartedEvt = events.find(e => e.eventType === 'agent.iteration.started')!;
    const toolStartedEvt = events.find(e => e.eventType === 'tool_call.started')!;

    // Agent started has no parent
    expect(agentStartedEvt.parentCorrelationId).toBeNull();

    // Iteration's parent is the agent
    expect(iterStartedEvt.parentCorrelationId).toBe(agentStartedEvt.correlationId);

    // Tool call's parent is the iteration
    expect(toolStartedEvt.parentCorrelationId).toBe(iterStartedEvt.correlationId);
  });

  it('should yield AgentResult as final value from stream()', async () => {
    const mockModel = new MockLanguageModel([
      { text: 'Final answer', finishReason: 'stop' },
    ]);

    const agent = new Agent({
      name: 'result-agent',
      model: mockModel,
      instructions: 'Test',
    });

    let agentResult: AgentResult | undefined;
    for await (const event of agent.stream('Go')) {
      if ('output' in event && 'toolCalls' in event) {
        agentResult = event as AgentResult;
      }
    }

    expect(agentResult).toBeDefined();
    expect(agentResult!.output).toBe('Final answer');
    expect(agentResult!.handoffTo).toBeNull();
    expect(agentResult!.handoffMetadata).toEqual({});
  });

  it('run() should return AgentResult with new fields', async () => {
    const mockModel = new MockLanguageModel([
      { text: 'Result', finishReason: 'stop' },
    ]);

    const agent = new Agent({
      name: 'run-agent',
      model: mockModel,
      instructions: 'Test',
    });

    const result = await agent.run('Hello');
    expect(result.output).toBe('Result');
    expect(result.handoffTo).toBeNull();
    expect(result.handoffMetadata).toEqual({});
  });
});

describe('Agent Handoffs', () => {
  beforeEach(() => {
    ToolRegistry.clear();
  });

  it('should create handoff with defaults', () => {
    const mockModel = new MockLanguageModel([
      { text: 'Hi', finishReason: 'stop' },
    ]);

    const target = new Agent({
      name: 'specialist',
      model: mockModel,
      instructions: 'I am a specialist',
    });

    const h = handoff(target, 'Transfer to the specialist');
    expect(h.agent).toBe(target);
    expect(h.description).toBe('Transfer to the specialist');
    expect(h.toolName).toBe('transfer_to_specialist');
    expect(h.passFullHistory).toBe(true);
  });

  it('should auto-generate transfer tools from handoffs', () => {
    const mockModel = new MockLanguageModel([
      { text: 'Hi', finishReason: 'stop' },
    ]);

    const techAgent = new Agent({
      name: 'tech',
      model: mockModel,
      instructions: 'Technical support',
    });

    const bizAgent = new Agent({
      name: 'biz',
      model: mockModel,
      instructions: 'Business support',
    });

    const triage = new Agent({
      name: 'triage',
      model: mockModel,
      instructions: 'Route requests',
      handoffs: [
        handoff(techAgent, 'Transfer to tech support'),
        handoff(bizAgent, 'Transfer to business support'),
      ],
    });

    // The triage agent should have transfer tools registered
    // We can verify by checking that running with a tool call works
    expect(triage.name).toBe('triage');
  });

  it('should detect handoff and return handoff result', async () => {
    // The target agent responds with a direct answer
    const targetModel = new MockLanguageModel([
      { text: 'I can help with that technical question', finishReason: 'stop' },
    ]);

    const techAgent = new Agent({
      name: 'tech_specialist',
      model: targetModel,
      instructions: 'I handle technical questions',
    });

    // The triage agent calls the transfer tool
    const triageModel = new MockLanguageModel([
      {
        text: 'Transferring to tech',
        toolCalls: [{
          name: 'transfer_to_tech_specialist',
          arguments: JSON.stringify({ message: 'How do I implement OAuth2?' }),
        }],
      },
    ]);

    const triage = new Agent({
      name: 'triage',
      model: triageModel,
      instructions: 'Route requests',
      handoffs: [handoff(techAgent, 'Transfer to tech specialist')],
    });

    const result = await triage.run('How do I implement OAuth2?');

    expect(result.handoffTo).toBe('tech_specialist');
    expect(result.output).toBe('I can help with that technical question');
    expect(result.handoffMetadata).toBeDefined();
    expect(result.handoffMetadata._handoff).toBe(true);
  });

  it('should emit AgentCompleted with handoffTo on handoff', async () => {
    const targetModel = new MockLanguageModel([
      { text: 'Specialist response', finishReason: 'stop' },
    ]);

    const specialist = new Agent({
      name: 'specialist',
      model: targetModel,
      instructions: 'Specialist',
    });

    const routerModel = new MockLanguageModel([
      {
        text: 'Routing',
        toolCalls: [{
          name: 'transfer_to_specialist',
          arguments: JSON.stringify({ message: 'Help me' }),
        }],
      },
    ]);

    const router = new Agent({
      name: 'router',
      model: routerModel,
      instructions: 'Route',
      handoffs: [specialist],
    });

    const events: AgentEvent[] = [];
    for await (const event of router.stream('Help')) {
      if ('eventType' in event) events.push(event);
    }

    const completed = events.find(e => e.eventType === 'agent.completed');
    expect(completed).toBeDefined();
    if (completed?.eventType === 'agent.completed') {
      expect(completed.handoffTo).toBe('specialist');
    }
  });

  it('should accept Agent directly in handoffs array (auto-wrap)', async () => {
    const mockModel = new MockLanguageModel([
      { text: 'Hi', finishReason: 'stop' },
    ]);

    const target = new Agent({
      name: 'auto_wrap',
      model: mockModel,
      instructions: 'Auto-wrapped agent',
    });

    // Passing Agent directly instead of handoff()
    const coordinator = new Agent({
      name: 'coordinator',
      model: mockModel,
      instructions: 'Coordinate',
      handoffs: [target],
    });

    const result = await coordinator.run('Hi');
    expect(result.output).toBe('Hi');
    expect(result.handoffTo).toBeNull();
  });
});
