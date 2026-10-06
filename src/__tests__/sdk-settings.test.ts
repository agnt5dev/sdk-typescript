import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, AgentRegistry } from '../agent.js';
import { FunctionRegistry } from '../function.js';
import { WorkflowRegistry } from '../workflow.js';
import { ToolRegistry } from '../tool.js';
import { Worker } from '../worker.js';
import { llmJudge } from '../scorer.js';
import { VERSION } from '../index.js';

describe('SDK settings', () => {
  beforeEach(() => {
    AgentRegistry.clear(); FunctionRegistry.clear(); WorkflowRegistry.clear(); ToolRegistry.clear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());
  it('exports the package version', () => {
    expect(VERSION).toBe(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
  });
  it('passes judge sampling configuration through the LM config', async () => {
    const generate = vi.fn(async () => ({ text: '{"score":1,"passed":true,"explanation":"correct"}' }));
    await llmJudge({ output: 'correct', config: { model: 'openai/gpt-4.1-mini', criteria: 'correctness', temperature: 0.42 } }, { llmJudgeLm: { generate } } as any);
    expect(generate.mock.calls[0][0]).toMatchObject({ config: { temperature: 0.42 } });
    expect(generate.mock.calls[0][0]).not.toHaveProperty('temperature');
  });
  it.each([true, false, undefined])('autoRegister=%s preserves explicit agents and discovers only when enabled', async (autoRegister) => {
    const options = { model: { generate: async () => ({ text: 'ok' }) } as any, modelName: 'test', instructions: 'Reply' };
    const imported = new Agent({ name: 'imported', ...options });
    const explicit = new Agent({ name: 'explicit', ...options });
    const native = { setComponents: vi.fn(), setMessageHandler: vi.fn(), setCancelHandler: vi.fn(), run: vi.fn() };
    const worker = new Worker('settings', { autoRegister });
    (worker as any).isInitialized = true;
    (worker as any).nativeWorker = native;
    worker.registerAgents([explicit]);
    await worker.run();
    const agents = native.setComponents.mock.calls[0][0].filter((entry: any) => entry.componentType === 'agent').map((entry: any) => entry.name);
    expect(agents).toContain(explicit.name);
    expect(agents.includes(imported.name)).toBe(autoRegister ?? false);
  });
});
