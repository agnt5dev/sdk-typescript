import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../agent.js';
import type { GenerateRequest, GenerateResponse, LanguageModel } from '../agent.js';
import { ContextImpl } from '../context.js';
import { ConfigurationError, ToolCannotPauseError } from '../errors.js';
import { AskUserTool, RequestApprovalTool, tool, ToolRegistry } from '../tool.js';
import { Worker } from '../worker.js';
import { workflow, WorkflowRegistry } from '../workflow.js';

/** Calls one tool, then answers "done" once it has seen a tool result. */
class ToolCallingModel implements LanguageModel {
  public requests: GenerateRequest[] = [];

  constructor(private readonly toolName: string, private readonly args: Record<string, unknown>) {}

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        text: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'call-1', name: this.toolName, arguments: JSON.stringify(this.args) }],
      };
    }
    return { text: 'done', finishReason: 'stop' };
  }

  /** Everything the model was shown after its tool call. */
  toolResults(): string {
    return JSON.stringify(this.requests.slice(1).map(request => request.messages));
  }
}

const metadata = { run_id: 'run-pause', project_id: 'project', dispatch_mode: 'pull', worker_session_id: 'session', lease_id: 'lease' };

function nativeWorker() {
  return { queueEvent: vi.fn(), emitCheckpoint: vi.fn(async () => {}), persistWorkflowState: vi.fn(async () => {}) };
}

async function dispatch(componentType: 'workflow' | 'tool', componentName: string, extra: Record<string, string> = {}, input: unknown = {}) {
  const worker = new Worker('tool-pause', { containProcessErrors: false });
  (worker as any).nativeWorker = nativeWorker();
  return JSON.parse(await (worker as any).processMessage({
    invocationId: 'run-pause',
    componentName,
    componentType,
    inputJson: JSON.stringify(input),
    metadata: { ...metadata, ...extra },
  }));
}

describe('a tool that cannot pause where an agent called it', () => {
  let published: string[];

  beforeEach(() => {
    ToolRegistry.clear();
    WorkflowRegistry.clear();
    published = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  function recordPublication() {
    tool(
      'record_publication',
      { description: 'Record a publication', confirmation: true },
      async (_ctx, args: { title: string }) => {
        published.push(args.title);
        return `recorded ${args.title}`;
      },
    );
    return ToolRegistry.get('record_publication')!;
  }

  it('fails the run when an agent inside a step calls a confirmation tool', async () => {
    const model = new ToolCallingModel('record_publication', { title: 'Q3 report' });
    const agent = new Agent({ name: 'publisher', model, instructions: 'Publish.', tools: [recordPublication()] });
    workflow('publish', async ctx => ctx.step('publish', async () => (await agent.run('Publish it', ctx)).output));

    const result = await dispatch('workflow', 'publish');

    expect(result).toMatchObject({ eventType: 'run.failed', errorType: 'ConfigurationError' });
    expect(result.error).toContain("Tool 'record_publication' requires confirmation");
    expect(result.error).toContain('from the workflow body');
    expect(published).toEqual([]);
    // The model was asked once and never shown the failure as a tool result.
    expect(model.requests).toHaveLength(1);
  });

  it.each([
    ['AskUserTool', 'ask_user', { question: 'Which focus?' }],
    ['RequestApprovalTool', 'request_approval', { action: 'Close the ticket' }],
  ] as const)('fails the run when an agent inside a step calls %s', async (className, toolName, args) => {
    const model = new ToolCallingModel(toolName, args);
    workflow('intake', async ctx => {
      const pauseTool = className === 'AskUserTool' ? new AskUserTool(ctx as any) : new RequestApprovalTool(ctx as any);
      const agent = new Agent({ name: 'intake', model, instructions: 'Ask.', tools: [pauseTool] });
      return ctx.step('intake', async () => (await agent.run('Start', ctx)).output);
    });

    const result = await dispatch('workflow', 'intake');

    expect(result).toMatchObject({ eventType: 'run.failed', errorType: 'ConfigurationError' });
    expect(result.error).toContain(`${className} pauses the run for a person`);
    expect(result.error).toContain('from the workflow body');
    expect(model.requests).toHaveLength(1);
  });

  it('raises an error that is still a ConfigurationError', async () => {
    const model = new ToolCallingModel('record_publication', { title: 'Q3 report' });
    const agent = new Agent({ name: 'publisher', model, instructions: 'Publish.', tools: [recordPublication()] });

    const ctx = new ContextImpl('inv-1', 'run-pause', 0, 'test', { storage: 'memory' });

    const failure = await ctx.step('publish', () => agent.run('Publish it', ctx)).catch(error => error);

    expect(failure).toBeInstanceOf(ToolCannotPauseError);
    expect(failure).toBeInstanceOf(ConfigurationError);
    expect(failure).toMatchObject({ name: 'ConfigurationError', code: 'TOOL_CANNOT_PAUSE', toolName: 'record_publication' });
    expect(published).toEqual([]);
    expect(model.requests).toHaveLength(1);
  });

  it('still hands an ordinary tool error back to the model', async () => {
    tool('lookup', { description: 'Look something up' }, async () => {
      throw new ConfigurationError('lookup is misconfigured');
    });
    const model = new ToolCallingModel('lookup', {});
    const agent = new Agent({ name: 'researcher', model, instructions: 'Look up.', tools: [ToolRegistry.get('lookup')!] });
    workflow('research', async ctx => ctx.step('research', async () => (await agent.run('Look it up', ctx)).output));

    const result = await dispatch('workflow', 'research');

    expect(result.eventType).toBe('run.completed');
    expect(JSON.parse(result.outputJson)).toBe('done');
    expect(model.requests).toHaveLength(2);
    expect(model.toolResults()).toContain('lookup is misconfigured');
  });

  it('still pauses when the agent runs in the workflow body, and runs the tool once approved', async () => {
    const model = new ToolCallingModel('record_publication', { title: 'Q3 report' });
    const agent = new Agent({ name: 'publisher', model, instructions: 'Publish.', tools: [recordPublication()] });
    workflow('publish', async ctx => (await agent.run('Publish it', ctx)).output);

    const paused = await dispatch('workflow', 'publish');
    expect(paused.eventType).toBe('workflow.paused');
    expect(paused.metadata.input_type).toBe('approval');
    expect(published).toEqual([]);

    model.requests = [];
    const completed = await dispatch('workflow', 'publish', { ...paused.metadata, user_response: 'approve' });
    expect(completed.eventType).toBe('run.completed');
    expect(published).toEqual(['Q3 report']);
  });

  it('still pauses for AskUserTool when the agent runs in the workflow body', async () => {
    const model = new ToolCallingModel('ask_user', { question: 'Which focus?' });
    workflow('intake', async ctx => {
      const agent = new Agent({ name: 'intake', model, instructions: 'Ask.', tools: [new AskUserTool(ctx as any)] });
      return (await agent.run('Start', ctx)).output;
    });

    const paused = await dispatch('workflow', 'intake');

    expect(paused.eventType).toBe('workflow.paused');
    expect(paused.metadata.question).toBe('Which focus?');
  });

  it('pauses a confirmation tool run directly, and runs it once approved', async () => {
    recordPublication();

    const paused = await dispatch('tool', 'record_publication', {}, { title: 'Q3 report' });
    expect(paused.eventType).toBe('workflow.paused');
    expect(paused.metadata.input_type).toBe('approval');
    expect(published).toEqual([]);

    const completed = await dispatch('tool', 'record_publication', { ...paused.metadata, user_response: 'approve' }, { title: 'Q3 report' });
    expect(completed.eventType).toBe('run.completed');
    expect(JSON.parse(completed.outputJson)).toBe('recorded Q3 report');
    expect(published).toEqual(['Q3 report']);
  });
});
