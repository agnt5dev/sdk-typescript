import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../agent.js';
import { EventEmitter } from '../event-emitter.js';
import { Worker } from '../worker.js';

describe('agent dispatch cleanup', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('closes the agent generator after event forwarding fails', async () => {
    const cleanup = vi.fn();
    const agent = {
      name: 'agent',
      async *stream() { try { yield { eventType: 'agent.started' }; } finally { cleanup(); } },
    } as unknown as Agent;
    const worker = new Worker('cleanup', { containProcessErrors: false });
    worker.registerAgents([agent]);
    const emit = EventEmitter.prototype.emit;
    vi.spyOn(EventEmitter.prototype, 'emit').mockImplementation(function(event) {
      if (event.eventType === 'agent.started') throw new Error('forwarding failed');
      return emit.call(this, event);
    });
    const result = JSON.parse(await (worker as any).processMessage({ invocationId: 'run', componentName: 'agent', componentType: 'agent', inputJson: '{"messages":[],"session_history_managed":true}', metadata: { run_id: 'run', dispatch_mode: 'pull' } }));
    expect(result).toMatchObject({ eventType: 'run.failed', error: 'forwarding failed' });
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
