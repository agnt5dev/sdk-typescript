import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../agent.js';
import { Tool } from '../tool.js';
import { HandoffDepthExceededError, MaxIterationsExceededError } from '../errors.js';

describe('agent run budgets', () => {
  it('rejects exhaustion without agent.completed or a raw tool result', async () => {
    const agent = new Agent({ name: 'limited', instructions: '', maxIterations: 1,
      model: { generate: async () => ({ text: '', toolCalls: [{ name: 'repeat', arguments: '{}' }] }) },
      tools: [new Tool('repeat', '', async () => ({ internal: 42 }))],
    });
    const events = [];
    await expect((async () => { for await (const event of agent.stream('go')) events.push(event); })()).rejects.toBeInstanceOf(MaxIterationsExceededError);
    expect(events.some(event => 'eventType' in event && event.eventType === 'agent.completed')).toBe(false);
  });

  it('bounds cyclic handoffs across agents with a shared root budget', async () => {
    const agents = ['first', 'second'].map(name => new Agent({ name, instructions: '', maxIterations: 1, maxHandoffDepth: 2,
      model: { generate: async request => ({ text: '', toolCalls: [{ name: request.tools![0].name, arguments: '{"message":"continue"}' }] }) },
    }));
    agents[0].addHandoff(agents[1]); agents[1].addHandoff(agents[0]);
    await expect(agents[0].run('go')).rejects.toBeInstanceOf(HandoffDepthExceededError);
  });

  it('cancels a pending custom model call and prevents further tools', async () => {
    let started!: () => void;
    const pending = new Promise<void>(resolve => { started = resolve; });
    const model = { generate: vi.fn(async request => { expect(request.signal).toBeInstanceOf(AbortSignal); started(); return await new Promise<any>(() => {}); }) };
    const agent = new Agent({ name: 'cancelled', instructions: '', model });
    const controller = new AbortController();
    const running = agent.run('go', undefined, undefined, { signal: controller.signal });
    await pending; controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(model.generate).toHaveBeenCalledOnce();
  });

  it('does not send an already cancelled request to a model', async () => {
    const model = { generate: vi.fn() };
    const controller = new AbortController(); controller.abort();
    const agent = new Agent({ name: 'pre-cancelled', instructions: '', model });
    await expect(agent.run('go', undefined, undefined, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(model.generate).not.toHaveBeenCalled();
  });
});
