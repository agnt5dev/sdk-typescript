import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Agent, AgentRegistry } from '../agent.js';
import {
  ActivationClient,
  ActivationKind,
  ActivationRecoveryPolicy,
  NativeActivationTransport,
  activationId,
  activationRequestFromContext,
  runWithActivation,
  type ActivationDecision,
  type BeginActivationRequest,
} from '../activation.js';
import { runWithContext } from '../async-context.js';
import { ContextImpl } from '../context.js';
import { currentDisplayParentCorrelationId, runWithDisplayParent } from '../display-parent-context.js';
import type { AgentEvent } from '../events.js';
import { LM } from '../lm.js';
import { Tool } from '../tool.js';

vi.mock('#native-loader', () => ({
  getLoadedNativeBindings: () => null,
  tryLoadNativeBindings: () => null,
}));

class RecordingTransport {
  readonly requests: BeginActivationRequest[] = [];

  async begin(request: BeginActivationRequest): Promise<ActivationDecision> {
    this.requests.push(request);
    return {
      kind: 'EXECUTE',
      activationId: await activationId(
        request.projectId, request.runId, request.parentActivationId,
        request.kind, request.stableKey,
      ),
      attempt: 1,
      acceptedJournalOffset: 1n,
      fenceToken: new Uint8Array([1]),
    };
  }

  async complete(request: { activationId: string; attempt: number }) {
    return { ...request, acceptedJournalOffset: 2n };
  }

  async fail(request: { activationId: string; attempt: number }) {
    return { ...request, acceptedJournalOffset: 2n, status: 'UNKNOWN_OUTCOME' };
  }
}

function fixtureContext(transport: RecordingTransport): ContextImpl {
  return new ContextImpl('invocation', 'run', 0, 'research', {
    storage: 'memory',
    metadata: {
      durable_activation_v1: 'true',
      project_id: 'project',
      worker_session_id: 'worker',
      run_authority: 'fixture-run-authority',
      lease_authority: 'fixture-lease-authority',
      activation_definition_version: 'v1',
      activation_artifact_sha256: '00'.repeat(32),
      activation_definition_config: '["object",[]]',
    },
    activationClient: new ActivationClient(transport),
  });
}

function fixtureModel(branch: string, overlap: () => Promise<void>): LM {
  let call = 0;
  const generate = async (request: { model: string }) => {
    const first = call++ === 0;
    if (first) await overlap();
    return {
      id: `response-${branch}-${call}`,
      model: request.model,
      text: first ? 'using tool' : 'done',
      toolCalls: first ? [{
        id: `call-${branch}`, name: `lookup_${branch}`, arguments: '{}',
      }] : [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: first ? 'tool_calls' : 'stop',
    };
  };
  const model = Object.create(LM.prototype) as LM;
  Object.assign(model, {
    providerName: 'openai',
    model: {
      generate,
      async stream(request: { model: string }, callback: (chunk: unknown) => void) {
        callback({ chunkType: 'completed', response: await generate(request) });
      },
    },
  });
  return model;
}

describe('durable agent display ancestry', () => {
  beforeEach(() => AgentRegistry.clear());

  it.each([false, true])('keeps concurrent model/tool calls under their own iteration (streaming=%s)', async streaming => {
    const transport = new RecordingTransport();
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const overlap = async () => {
      if (++arrived === 2) release();
      await gate;
    };
    const branches = ['left', 'right'].map(branch => {
      const context = fixtureContext(transport);
      const events: AgentEvent[] = [];
      context.emit = async event => { events.push(event); };
      const agent = new Agent({
        name: `agent_${branch}`,
        instructions: 'Call the lookup tool once',
        model: fixtureModel(branch, overlap),
        modelName: `openai/model_${branch}`,
        tools: [new Tool(`lookup_${branch}`, 'Lookup', async () => 'result', {
          inputSchema: { type: 'object', properties: {} },
        })],
        // Model callbacks select the non-streaming path without replacing it.
        callbacks: streaming ? undefined : { beforeModel: () => undefined },
      });
      return { branch, context, events, agent };
    });

    await runWithActivation({
      kind: 'EXECUTE', activationId: 'research-step', attempt: 1,
      acceptedJournalOffset: 0n,
    }, () => Promise.all(branches.map(({ agent, context }) => runWithContext(
      { runId: context.runId, executionContext: context },
      () => agent.run('research', context),
    ))));

    for (const { branch, events } of branches) {
      const iterations = events.filter(event => event.eventType === 'agent.iteration.started');
      expect(iterations).toHaveLength(2);
      const requests = transport.requests.filter(request => request.displayName.endsWith(`_${branch}`));
      expect(requests.map(request => request.kind)).toEqual([
        ActivationKind.Model, ActivationKind.Tool, ActivationKind.Model,
      ]);
      expect(requests.map(request => request.parentActivationId)).toEqual([
        'research-step', 'research-step', 'research-step',
      ]);
      expect(requests.map(request => request.displayParentCorrelationId)).toEqual([
        iterations[0].correlationId, iterations[0].correlationId, iterations[1].correlationId,
      ]);
    }
  });

  it('does not leak an iteration display parent into a durable tool\'s own model calls', async () => {
    const transport = new RecordingTransport();
    const context = fixtureContext(transport);
    const model = fixtureModel('nested', async () => {});
    const nestedTool = new Tool('nested_lookup', 'Lookup', async () => {
      await model.generate({ model: 'openai/nested', messages: [] });
      return 'done';
    }, { inputSchema: { type: 'object', properties: {} } });

    await runWithContext({ runId: context.runId, executionContext: context }, () =>
      runWithActivation({
        kind: 'EXECUTE', activationId: 'research-step', attempt: 1,
        acceptedJournalOffset: 0n,
      }, () => runWithDisplayParent('iteration', async () => {
        await nestedTool.invoke(context, {});
        expect(currentDisplayParentCorrelationId()).toBe('iteration');
      })),
    );

    const [toolRequest, modelRequest] = transport.requests;
    expect(toolRequest.displayParentCorrelationId).toBe('iteration');
    expect(modelRequest.displayParentCorrelationId).toBeUndefined();
    expect(modelRequest.parentActivationId).toBe(await activationId(
      toolRequest.projectId, toolRequest.runId, toolRequest.parentActivationId,
      toolRequest.kind, toolRequest.stableKey,
    ));
    expect(currentDisplayParentCorrelationId()).toBeUndefined();
  });

  it('forwards reader ancestry without changing identity or logical request digests', async () => {
    const transport = new RecordingTransport();
    const context = fixtureContext(transport);
    const request = () => activationRequestFromContext(context, {
      kind: ActivationKind.Model,
      stableKey: 'fixed-model-key',
      input: { message: 'hello' },
      recoveryPolicy: ActivationRecoveryPolicy.UnknownOutcome,
    });
    const first = await runWithDisplayParent('iteration-original', request);
    const replay = await runWithDisplayParent('iteration-replayed', request);
    const { displayParentCorrelationId: firstParent, ...firstIdentity } = first;
    const { displayParentCorrelationId: replayParent, ...replayIdentity } = replay;
    expect(firstParent).toBe('iteration-original');
    expect(replayParent).toBe('iteration-replayed');
    expect(replayIdentity).toEqual(firstIdentity);

    const nativeWorker = {
      beginActivation: vi.fn(value => transport.begin(value)),
      completeActivation: vi.fn(),
      failActivation: vi.fn(),
    };
    const client = new ActivationClient(new NativeActivationTransport(nativeWorker));
    const firstDecision = await client.begin(first);
    const replayDecision = await client.begin(replay);
    expect(replayDecision.activationId).toBe(firstDecision.activationId);
    expect(nativeWorker.beginActivation).toHaveBeenLastCalledWith(replay);
    expect((await request()).displayParentCorrelationId).toBeUndefined();
  });
});
