import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../agent.js';
import { Worker } from '../worker.js';

function echoAgent(received: string[]): Agent {
  return {
    name: 'echo',
    async *stream(message: string) {
      received.push(message);
      yield { output: `echo: ${message}`, toolCalls: [], context: {} };
    },
  } as unknown as Agent;
}

async function dispatch(input: Record<string, unknown>) {
  const received: string[] = [];
  const worker = new Worker('agent-input', { containProcessErrors: false });
  worker.registerAgents([echoAgent(received)]);
  const load = vi.spyOn(worker as any, '_loadSessionHistory').mockResolvedValue([]);
  const save = vi.spyOn(worker as any, '_saveSessionHistory').mockResolvedValue(undefined);
  const result = JSON.parse(await (worker as any).processMessage({
    invocationId: 'run',
    componentName: 'echo',
    componentType: 'agent',
    inputJson: JSON.stringify(input),
    metadata: { run_id: 'run', dispatch_mode: 'pull' },
  }));
  return { result, received, load, save };
}

describe('agent dispatch input', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('uses `input` as the message for an MCP agent tool call', async () => {
    // A hosted MCP server forwards an agent tool's arguments unchanged:
    // { input, session_id? } (AGENT_INPUT_SCHEMA).
    const { result, received, load, save } = await dispatch({ input: 'hello', session_id: 'mcp-session' });

    expect(result.eventType).not.toBe('run.failed');
    expect(received).toEqual(['hello']);
    expect(load).toHaveBeenCalledWith('mcp-session', 'echo', expect.anything());
    expect(save.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({ role: 'user', content: 'hello' }),
      expect.objectContaining({ role: 'assistant', content: 'echo: hello' }),
    ]);
  });

  it('prefers `message` over `input`', async () => {
    const { result, received } = await dispatch({ message: 'hello', input: 'ignored' });

    expect(result.eventType).not.toBe('run.failed');
    expect(received).toEqual(['hello']);
  });

  it('passes an empty `input` through rather than its JSON', async () => {
    const { result, received } = await dispatch({ input: '' });

    expect(result.eventType).not.toBe('run.failed');
    expect(received).toEqual(['']);
  });
});
