import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '../types.js';
import { Worker } from '../worker.js';
import { serve } from '../workerless.js';
import { WorkflowRegistry, workflow } from '../workflow.js';

type Handler = (ctx: Context) => Promise<unknown>;
type Result = { status: 'completed' | 'paused'; output?: unknown; stepEvents?: Record<string, string | null> };

async function managed(handler: Handler, extra: Record<string, string>): Promise<Result> {
  workflow('hitl-question', handler);
  const worker = new Worker('hitl-response-test', { containProcessErrors: false });
  (worker as any).nativeWorker = {
    queueEvent: vi.fn(),
    emitCheckpoint: vi.fn(async () => {}),
    persistWorkflowState: vi.fn(async () => {}),
  };
  const result = JSON.parse(await (worker as any).processMessage({
    invocationId: 'run-hitl', componentName: 'hitl-question', componentType: 'workflow', inputJson: '{}',
    metadata: {
      run_id: 'run-hitl', project_id: 'project', dispatch_mode: 'pull',
      worker_session_id: 'session', lease_id: 'lease', ...extra,
    },
  }));
  if (result.eventType === 'workflow.paused') {
    return { status: 'paused', stepEvents: JSON.parse(result.metadata.step_events || '{}') };
  }
  expect(result.eventType).toBe('run.completed');
  return { status: 'completed', output: JSON.parse(result.outputJson) };
}

async function workerless(handler: Handler, metadata: Record<string, string>): Promise<Result> {
  const question = workflow('hitl-question', handler);
  const server = serve({ allowUnsigned: true, workflows: [question] });
  const response = await server.fetch(new Request('http://localhost/agnt5/invoke', {
    method: 'POST',
    body: JSON.stringify({
      run_id: 'run-hitl', component_type: 'workflow', component_name: 'hitl-question', input: {}, metadata,
    }),
  }));
  const result = await response.json() as any;
  if (result.status === 'suspended') {
    expect(result.reason).toBe('user_input_required');
    return { status: 'paused', stepEvents: result.step_events };
  }
  expect(result.status).toBe('completed');
  return { status: 'completed', output: result.output };
}

describe.each([
  { surface: 'managed worker', dispatch: managed },
  { surface: 'workerless', dispatch: workerless },
])('$surface HITL responses', ({ dispatch }) => {
  beforeEach(() => {
    WorkflowRegistry.clear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['multiselect', 'pick_many'])('decodes typed entries for %s', async inputType => {
    const result = await dispatch(ctx => ctx.waitForUser('Pick topics', { inputType: 'multiselect' }), {
      pause_index: '0', input_type: inputType, user_response: '["ai","__custom__:Rust"]',
    });
    expect(result).toEqual({ status: 'completed', output: '["ai","Rust"]' });
  });

  it.each(['text', 'approval', 'select', undefined, 'unknown'])('preserves literal arrays for input type %s', async inputType => {
    const answer = '["ai","__custom__:Rust"]';
    const result = await dispatch(ctx => ctx.waitForUser('Enter an answer', {
      inputType: inputType === 'approval' || inputType === 'select' ? inputType : 'text',
    }), {
      pause_index: '0', user_response: answer, ...(inputType === undefined ? {} : { input_type: inputType }),
    });
    expect(result).toEqual({ status: 'completed', output: answer });
  });

  it('strips only the outer prefix of a standalone custom JSON answer', async () => {
    const answer = '["ai","__custom__:Rust"]';
    const result = await dispatch(ctx => ctx.waitForUser('Pick topics', { inputType: 'multiselect' }), {
      pause_index: '0', input_type: 'multiselect', user_response: `__custom__:${answer}`,
    });
    expect(result).toEqual({ status: 'completed', output: answer });
  });

  it('does not decode a historical answer again', async () => {
    const answer = '["ai","__custom__:Rust"]';
    const result = await dispatch(ctx => ctx.waitForUser('Pick topics', { inputType: 'multiselect' }), {
      input_type: 'multiselect', step_events: JSON.stringify({ 0: answer }),
    });
    expect(result).toEqual({ status: 'completed', output: answer });
  });

  it('keeps decoded custom text intact across the next pause and replay', async () => {
    const ask: Handler = async ctx => {
      const topics = await ctx.waitForUser('Pick topics', { inputType: 'multiselect' });
      await ctx.waitForUser('Continue?', { inputType: 'approval' });
      return topics;
    };
    const paused = await dispatch(ask, {
      pause_index: '0', input_type: 'multiselect', user_response: '["ai","__custom__:__custom__:Rust"]',
    });
    expect(paused).toEqual({ status: 'paused', stepEvents: { 0: '["ai","__custom__:Rust"]' } });

    WorkflowRegistry.clear();
    const completed = await dispatch(ask, {
      pause_index: '1', input_type: 'approval', user_response: 'approve',
      step_events: JSON.stringify(paused.stepEvents),
    });
    expect(completed).toEqual({ status: 'completed', output: '["ai","__custom__:Rust"]' });
  });
});
