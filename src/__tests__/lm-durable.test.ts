import { describe, expect, it, vi } from 'vitest';

import {
  ActivationClient,
  ActivationKind,
  ActivationRecoveryPolicy,
  activationId,
} from '../activation.js';
import type {
  ActivationDecision,
  BeginActivationRequest,
} from '../activation.js';
import { runWithContext } from '../async-context.js';
import { ContextImpl } from '../context.js';
import { LM } from '../lm.js';

const generate = vi.fn(async (request: any) => ({
  id: 'response-1',
  model: request.model,
  text: 'provider final',
  usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
  finishReason: 'stop',
}));
const stream = vi.fn(async (request: any, callback: (chunk: any) => void) => {
  callback({ chunkType: 'delta', content: 'provider ' });
  callback({
    chunkType: 'completed',
    response: {
      id: 'response-stream-1',
      model: request.model,
      text: 'provider final',
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      finishReason: 'stop',
    },
  });
});

vi.mock('../native-loader.js', () => ({
  loadNativeBindings: () => ({
    LanguageModel: {
      openai: vi.fn(() => ({ generate, stream })),
    },
  }),
}));

class ModelActivationTransport {
  readonly beginRequests: BeginActivationRequest[] = [];
  readonly completeRequests: any[] = [];
  readonly failRequests: any[] = [];

  constructor(private readonly replay?: Record<string, unknown>) {}

  async begin(request: BeginActivationRequest): Promise<ActivationDecision> {
    this.beginRequests.push(request);
    return {
      kind: this.replay ? 'REPLAY' : 'EXECUTE',
      activationId: await activationId(
        request.projectId,
        request.runId,
        request.parentActivationId,
        request.kind,
        request.stableKey,
      ),
      attempt: 1,
      acceptedJournalOffset: 7n,
      fenceToken: this.replay ? undefined : new Uint8Array([1]),
      replayOutput: this.replay
        ? new TextEncoder().encode(JSON.stringify(this.replay))
        : undefined,
    };
  }

  async complete(request: any) {
    this.completeRequests.push(request);
    return {
      activationId: request.activationId,
      attempt: request.attempt,
      acceptedJournalOffset: 8n,
    };
  }

  async fail(request: any) {
    this.failRequests.push(request);
    return {
      activationId: request.activationId,
      attempt: request.attempt,
      acceptedJournalOffset: 8n,
      status: 'UNKNOWN_OUTCOME',
    };
  }
}

function durableContext(transport: ModelActivationTransport): ContextImpl {
  return new ContextImpl('inv-1', 'run-1', 0, 'research-agent', {
    metadata: {
      durable_activation_v1: 'true',
      project_id: 'project-1',
      component_name: 'research-agent',
      worker_session_id: 'worker-session-1',
      run_authority: 'run-authority-1',
      lease_authority: 'lease-authority-1',
      activation_definition_version: 'v1',
      activation_artifact_sha256: '00'.repeat(32),
      activation_definition_config: '["object",[]]',
    },
    activationClient: new ActivationClient(transport),
  });
}

describe('LM durable activation', () => {
  it('commits an accepted model final and exposes a downstream key', async () => {
    generate.mockClear();
    const transport = new ModelActivationTransport();
    const context = durableContext(transport);
    let observedActivation: unknown;
    generate.mockImplementationOnce(async request => {
      observedActivation = context.activation;
      return {
        id: 'response-1',
        model: request.model,
        text: 'provider final',
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
        finishReason: 'stop',
      };
    });

    const response = await runWithContext(
      { runId: context.runId, executionContext: context },
      () => LM.openai().generate({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    );

    expect(response.text).toBe('provider final');
    expect(transport.beginRequests[0].kind).toBe(ActivationKind.Model);
    expect(transport.beginRequests[0].stableKey).toBe('model:openai/gpt-4o-mini:0');
    expect(transport.beginRequests[0].recoveryPolicy)
      .toBe(ActivationRecoveryPolicy.UnknownOutcome);
    expect(transport.completeRequests).toHaveLength(1);
    expect(transport.completeRequests[0].usage).toMatchObject({
      tokensIn: 3,
      tokensOut: 2,
      provider: 'openai',
      model: 'openai/gpt-4o-mini',
    });
    expect(transport.completeRequests[0].evidence[0].evidenceType)
      .toBe('model_provider_terminal_v1');
    expect(observedActivation).toMatchObject({
      idempotencyKey: expect.stringMatching(/^agnt5:actv1_/),
    });
    expect(context.activation).toBeUndefined();
    expect(generate).toHaveBeenCalledOnce();
  });

  it('replays an accepted final without another provider call', async () => {
    generate.mockClear();
    const transport = new ModelActivationTransport({
      id: 'response-replay',
      model: 'openai/gpt-4o-mini',
      text: 'replayed final',
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      finishReason: 'stop',
    });
    const context = durableContext(transport);

    const response = await runWithContext(
      { runId: context.runId, executionContext: context },
      () => LM.openai().generate({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    );

    expect(response.text).toBe('replayed final');
    expect(response.usage?.totalTokens).toBe(5);
    expect(generate).not.toHaveBeenCalled();
    expect(transport.completeRequests).toHaveLength(0);
  });

  it('withholds a stream final until durable completion is accepted', async () => {
    stream.mockClear();
    const transport = new ModelActivationTransport();
    const context = durableContext(transport);
    const chunks: any[] = [];

    await runWithContext(
      { runId: context.runId, executionContext: context },
      () => LM.openai().stream({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
      }, chunk => {
        if (chunk.chunkType === 'completed') {
          expect(transport.completeRequests).toHaveLength(1);
        }
        chunks.push(chunk);
      }),
    );

    expect(chunks.map(chunk => chunk.chunkType)).toEqual(['delta', 'completed']);
    expect(transport.completeRequests[0].usage).toMatchObject({
      tokensIn: 3,
      tokensOut: 2,
      provider: 'openai',
      model: 'openai/gpt-4o-mini',
    });
    expect(transport.completeRequests[0].evidence[0].evidenceType)
      .toBe('model_provider_terminal_v1');
    expect(transport.failRequests).toHaveLength(0);
    expect(stream).toHaveBeenCalledOnce();
  });

  it('replays an accepted stream final without another provider stream', async () => {
    stream.mockClear();
    const transport = new ModelActivationTransport({
      id: 'response-replay',
      model: 'openai/gpt-4o-mini',
      text: 'replayed stream final',
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      finishReason: 'stop',
    });
    const context = durableContext(transport);
    const chunks: any[] = [];

    await runWithContext(
      { runId: context.runId, executionContext: context },
      () => LM.openai().stream({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
      }, chunk => chunks.push(chunk)),
    );

    expect(chunks).toMatchObject([
      { chunkType: 'delta', content: 'replayed stream final' },
      { chunkType: 'completed', response: { text: 'replayed stream final' } },
    ]);
    expect(stream).not.toHaveBeenCalled();
    expect(transport.completeRequests).toHaveLength(0);
  });

  it('classifies an interrupted stream with bounded non-text evidence', async () => {
    stream.mockReset();
    stream.mockImplementationOnce(async (_request, callback) => {
      callback({ chunkType: 'delta', content: 'partial' });
      throw new Error('provider stream interrupted');
    });
    const transport = new ModelActivationTransport();
    const context = durableContext(transport);
    const chunks: any[] = [];

    await expect(runWithContext(
      { runId: context.runId, executionContext: context },
      () => LM.openai().stream({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
      }, chunk => chunks.push(chunk)),
    )).rejects.toThrow('provider stream interrupted');

    expect(chunks).toEqual([{ chunkType: 'delta', content: 'partial' }]);
    expect(transport.completeRequests).toHaveLength(0);
    expect(transport.failRequests).toHaveLength(1);
    const failure = transport.failRequests[0];
    expect(failure.errorCode).toBe('MODEL_STREAM_INTERRUPTED');
    const evidenceText = new TextDecoder().decode(failure.evidence[0].payload);
    expect(evidenceText).toContain('"partialChunks":1');
    expect(evidenceText).toContain('"partialUtf8Bytes":7');
    expect(evidenceText).not.toContain('"partial"');
  });
});
