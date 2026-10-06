import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../agent.js';
import { Tool } from '../tool.js';
import { HandoffDepthExceededError, MaxIterationsExceededError } from '../errors.js';
import { ContextImpl } from '../context.js';

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

  it.each([false, true])('passes caller cancellation to an in-flight tool (context=%s)', async suppliedContext => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let toolSignal: AbortSignal | undefined;
    const stopped = vi.fn();
    const context = suppliedContext ? new ContextImpl('agent', 'agent', 0, 'agent', { storage: 'memory' }) : undefined;
    const model = { generate: vi.fn(async () => ({ text: '', toolCalls: [{ name: 'wait', arguments: '{}' }] })) };
    const agent = new Agent({ name: 'tool-cancel', instructions: '', model,
      tools: [new Tool('wait', '', async ctx => {
        toolSignal = ctx.signal; started();
        return await new Promise<never>((_, reject) => ctx.signal.addEventListener('abort', () => { stopped(); reject(ctx.signal.reason); }, { once: true }));
      })],
    });
    const controller = new AbortController();
    const running = agent.run('go', context, undefined, { signal: controller.signal });
    const outcome = expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await ready; controller.abort(); await outcome;
    expect(toolSignal?.aborted).toBe(true);
    expect(stopped).toHaveBeenCalledOnce();
    expect(context?.signal.aborted ?? false).toBe(false);
    expect(model.generate).toHaveBeenCalledOnce();
  });

  it('unwinds the agent and closes its sandbox when a tool ignores cancellation', async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const close = vi.fn(async () => {});
    const agent = new Agent({ name: 'uncooperative-tool', instructions: '',
      model: { generate: async () => ({ text: '', toolCalls: [{ name: 'wait', arguments: '{}' }] }) },
      tools: [new Tool('wait', '', async () => { started(); return await new Promise(() => {}); })],
      sandbox: { close } as any,
    });
    const controller = new AbortController();
    const running = agent.run('go', undefined, undefined, { signal: controller.signal });
    const outcome = expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await ready; controller.abort(); await outcome;
    await new Promise(resolve => setImmediate(resolve));
    expect(close).toHaveBeenCalledOnce();
  });
});
