import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
const exec = promisify(execFile);

describe('worker process containment', () => {
  it.each(['rejection', 'exception', 'rejection-return', 'exception-return', 'rejection-pause', 'exception-pause', 'rejection-hitl', 'exception-hitl', 'agent-rejection'])('contains detached %s without interrupting another run', async mode => {
    const { stdout } = await exec(process.execPath, ['src/__tests__/fixtures/detached-errors.mjs', mode], { cwd: process.cwd(), timeout: 5000 });
    const result = JSON.parse(stdout.trim());
    expect(result.listeners).toEqual([1, 1]);
    expect(result.after).toEqual([0, 0]);
    expect(result.outcomes[0]).toMatchObject({ eventType: 'run.failed', errorType: 'TypeError', error: 'detached failure' });
    expect(result.outcomes[0].errorStack).toContain('detached-errors.mjs');
    expect(result.outcomes[1]).toMatchObject({ eventType: 'run.completed', outputJson: '"healthy"' });
    expect(result.terminals).toEqual([]);
    if (mode === 'agent-rejection') expect(result.agentClosed).toBe(true);
  });
});
