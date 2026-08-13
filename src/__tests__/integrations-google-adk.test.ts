import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseAgent, BaseLlm, FunctionTool, InMemoryRunner, LlmAgent, Runner } from '@google/adk';
import { runWithContext } from '../async-context.js';
import {
  createGoogleADKCapturePlugin,
  disableGoogleADKCapture,
  enableGoogleADKCapture,
  supportedVersion,
} from '../integrations/google-adk.js';

beforeEach(() => {
  delete process.env.AGNT5_CAPTURE;
  delete process.env.AGNT5_CAPTURE_GOOGLE_ADK;
});

afterEach(() => {
  disableGoogleADKCapture();
  delete process.env.AGNT5_CAPTURE_GOOGLE_ADK;
});

describe('Google ADK capture', () => {
  it('translates agent, model, and tool plugin callbacks', async () => {
    const ctx = fakeContext('fn-parent');
    await enableGoogleADKCapture();
    const plugin = await createGoogleADKCapturePlugin();
    const callbackContext = { invocationId: 'inv-1', agentName: 'helper' };
    const toolContext = { ...callbackContext, functionCallId: 'call-1' };

    await runWithContext({ runId: 'run-1', executionContext: ctx as any }, async () => {
      await plugin.beforeAgentCallback({ agent: { name: 'helper', model: 'gemini-2.5-flash' }, callbackContext });
      await plugin.beforeModelCallback({
        callbackContext,
        llmRequest: {
          model: 'gemini-2.5-flash',
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          config: { temperature: 0, maxOutputTokens: 16 },
          toolsDict: {},
        },
      });
      await plugin.beforeToolCallback({ tool: { name: 'lookup' }, toolArgs: { q: 'x' }, toolContext });
    });
    await plugin.afterModelCallback({
      callbackContext,
      llmResponse: {
        modelVersion: 'gemini-2.5-flash-001',
        content: { parts: [{ text: 'pong' }] },
        finishReason: 'STOP',
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 1,
          totalTokenCount: 5,
          cachedContentTokenCount: 2,
        },
      },
    });
    await plugin.afterToolCallback({ tool: { name: 'lookup' }, toolContext, result: { ok: true } });
    await plugin.afterAgentCallback({ agent: { name: 'helper' }, callbackContext });

    const events = capturedEvents(ctx);
    expect(events.map((event) => event.eventType)).toEqual([
      'agent.started', 'lm.started', 'tool_call.started',
      'lm.completed', 'tool_call.completed', 'agent.completed',
    ]);
    expect(events[1].parentCorrelationId).toBe(events[0].correlationId);
    expect(events[3].metadata).toMatchObject({
      provider: 'google', cached_tokens: '2', total_tokens: '5',
      capture_mode: 'observed', source: 'google_adk',
    });
  });

  it('captures a deterministic full Runner model and tool loop', async () => {
    class FakeLlm extends BaseLlm {
      override async *generateContentAsync(llmRequest: any) {
        const hasToolResult = (llmRequest.contents ?? []).some((content: any) =>
          (content.parts ?? []).some((part: any) => part.functionResponse !== undefined),
        );
        const usageMetadata = {
          promptTokenCount: 7,
          candidatesTokenCount: 5,
          totalTokenCount: 12,
        };
        yield hasToolResult
          ? { content: { role: 'model', parts: [{ text: 'tool-run-complete' }] }, usageMetadata }
          : {
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'echo', args: { text: 'ping' } } }],
              },
              usageMetadata,
            };
      }

      override async connect(): Promise<never> {
        throw new Error('FakeLlm does not support live connections');
      }
    }

    const ctx = fakeContext('fn-runner');
    await enableGoogleADKCapture();
    const agent = new LlmAgent({
      name: 'runner_agent',
      model: new FakeLlm({ model: 'fake-deterministic' }),
      instruction: 'Use the echo tool, then finish.',
      tools: [new FunctionTool({
        name: 'echo',
        description: 'Echo text.',
        parameters: {
          type: 'OBJECT',
          properties: { text: { type: 'STRING' } },
          required: ['text'],
        } as never,
        execute: (args: unknown) => ({ echoed: (args as { text: string }).text }),
      })],
    });
    const runner = new InMemoryRunner({ agent, appName: 'capture-test' });
    let finalText = '';
    await runWithContext({ runId: 'run-adk', executionContext: ctx as any }, async () => {
      for await (const event of runner.runEphemeral({
        userId: 'tester',
        newMessage: { role: 'user', parts: [{ text: 'ping' }] },
      })) {
        for (const part of event.content?.parts ?? []) finalText += part.text ?? '';
      }
    });

    expect(finalText).toContain('tool-run-complete');
    expect(capturedEvents(ctx).map((event) => event.eventType)).toEqual([
      'agent.started',
      'lm.started',
      'lm.completed',
      'tool_call.started',
      'tool_call.completed',
      'lm.started',
      'lm.completed',
      'agent.completed',
    ]);
  });

  it('maps a propagated Runner failure to agent.failed', async () => {
    class FailingAgent extends BaseAgent {
      protected override async *runAsyncImpl(): AsyncGenerator<never, void> {
        throw new Error('deterministic agent failure');
      }

      protected override async *runLiveImpl(): AsyncGenerator<never, void> {
        throw new Error('deterministic agent failure');
      }
    }

    const ctx = fakeContext('fn-failure');
    await enableGoogleADKCapture();
    const runner = new InMemoryRunner({
      appName: 'capture-failure-test',
      agent: new FailingAgent({ name: 'failing_agent' }),
    });
    await expect(runWithContext(
      { runId: 'run-adk-failure', executionContext: ctx as any },
      async () => {
        for await (const _event of runner.runEphemeral({
          userId: 'tester',
          newMessage: { role: 'user', parts: [{ text: 'ping' }] },
        })) {
          // The fake agent fails before producing an event.
        }
      },
    )).rejects.toThrow('deterministic agent failure');

    expect(capturedEvents(ctx).map((event) => event.eventType)).toEqual([
      'agent.started', 'agent.failed',
    ]);
  });

  it('maps model and tool errors without re-reading ambient context', async () => {
    const ctx = fakeContext('fn-error');
    await enableGoogleADKCapture();
    const plugin = await createGoogleADKCapturePlugin();
    const callbackContext = { invocationId: 'inv-error', agentName: 'helper' };
    const toolContext = { ...callbackContext, functionCallId: 'call-error' };
    await runWithContext({ runId: 'run-error', executionContext: ctx as any }, async () => {
      await plugin.beforeModelCallback({ callbackContext, llmRequest: { model: 'gemini-2.5-flash' } });
      await plugin.beforeToolCallback({ tool: { name: 'lookup' }, toolArgs: {}, toolContext });
    });
    await plugin.onModelErrorCallback({ callbackContext, llmRequest: {}, error: new Error('model failed') });
    await plugin.onToolErrorCallback({ tool: { name: 'lookup' }, toolContext, error: new Error('tool failed') });
    expect(capturedEvents(ctx).map((event) => event.eventType)).toEqual([
      'lm.started', 'tool_call.started', 'lm.failed', 'tool_call.failed',
    ]);
  });

  it('attaches once through the public plugin manager before Runner execution', async () => {
    await enableGoogleADKCapture();
    await enableGoogleADKCapture();
    const plugins = new Map<string, any>();
    const runner = Object.create(Runner.prototype);
    Object.defineProperty(runner, 'pluginManager', {
      value: {
        getPlugin: (name: string) => plugins.get(name),
        registerPlugin: vi.fn((plugin: any) => plugins.set(plugin.name, plugin)),
      },
    });
    (runner as any).runAsync({ userId: 'u', sessionId: 's', newMessage: { role: 'user', parts: [] } });
    (runner as any).runAsync({ userId: 'u', sessionId: 's', newMessage: { role: 'user', parts: [] } });
    expect((runner as any).pluginManager.registerPlugin).toHaveBeenCalledOnce();
    expect(plugins.has('agnt5_capture')).toBe(true);
  });

  it('supports Google ADK 1.x and later only', () => {
    expect(supportedVersion('1.6.0')).toBe(true);
    expect(supportedVersion('2.0.0')).toBe(true);
    expect(supportedVersion('2.0.0-beta.1')).toBe(true);
    expect(supportedVersion('0.6.1')).toBe(false);
    expect(supportedVersion('0.9.9')).toBe(false);
    expect(supportedVersion('1.6')).toBe(false);
    expect(supportedVersion('unknown')).toBe(false);
  });

  it('is a no-op without ambient context', async () => {
    await enableGoogleADKCapture();
    const plugin = await createGoogleADKCapturePlugin();
    await plugin.beforeAgentCallback({
      agent: { name: 'helper' }, callbackContext: { invocationId: 'none', agentName: 'helper' },
    });
    expect((plugin as any).agentSpans.size).toBe(0);
  });

  it('honors the per-library kill switch', async () => {
    process.env.AGNT5_CAPTURE_GOOGLE_ADK = 'no';
    expect(await enableGoogleADKCapture()).toBe(false);
    expect(await createGoogleADKCapturePlugin()).toBeUndefined();
  });
});

function fakeContext(parent: string) {
  return {
    runId: `run-${parent}`,
    emit: vi.fn(async () => undefined),
    getCurrentCorrelationId: vi.fn(() => parent),
  };
}

function capturedEvents(ctx: ReturnType<typeof fakeContext>): any[] {
  return ctx.emit.mock.calls.map(([event]) => event);
}
