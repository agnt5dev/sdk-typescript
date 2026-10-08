import { describe, expect, it, vi } from 'vitest';
import {
  ActivationClient,
  ActivationDecision,
  ActivationKind,
  ActivationRecoveryPolicy,
  ActivationTransport,
  BeginActivationRequest,
  ChildJoinPolicy,
  Float64,
  NativeActivationTransport,
  UInt64,
  activationDefinitionDigest,
  activationId,
  boundedInputData,
  canonicalActivationValue,
  childActivationRequestFromContext,
  sha256,
  stableStepKey,
  stepActivationRequest,
  runWithActivation,
  timerActivationRequest,
} from '../activation.js';
import { ContextImpl } from '../context.js';
import { normalizeStepInput } from '../step-input.js';
import { ActivationError, ActivationErrorCode } from '../errors.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(value: Uint8Array): number[] {
  return [...value];
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

function request(): BeginActivationRequest {
  return {
    projectId: 'project-1',
    runId: 'run-1',
    parentActivationId: '',
    kind: ActivationKind.Step,
    stableKey: 'step:load:0',
    inputDigest: new Uint8Array(32),
    definitionDigest: new Uint8Array(32),
    recoveryPolicy: ActivationRecoveryPolicy.DurableSteps,
    workerSessionId: 'session-1',
    runAuthority: encoder.encode('run-authority'),
    leaseAuthority: encoder.encode('lease-authority'),
    displayName: 'load',
  };
}

function decodeInput(value: Uint8Array | undefined): unknown {
  return value ? JSON.parse(decoder.decode(value)) : undefined;
}

class RecordingTransport implements ActivationTransport {
  beginRequests: BeginActivationRequest[] = [];
  completeRequests: Parameters<ActivationTransport['complete']>[0][] = [];
  failRequests: Parameters<ActivationTransport['fail']>[0][] = [];
  completeError?: Error;
  failError?: Error;

  constructor(public decision: ActivationDecision) {}

  async begin(value: BeginActivationRequest): Promise<ActivationDecision> {
    this.beginRequests.push(value);
    return this.decision;
  }

  async complete(value: Parameters<ActivationTransport['complete']>[0]) {
    this.completeRequests.push(value);
    if (this.completeError) throw this.completeError;
    return {
      activationId: value.activationId,
      attempt: value.attempt,
      acceptedJournalOffset: 12n,
    };
  }

  async fail(value: Parameters<ActivationTransport['fail']>[0]) {
    this.failRequests.push(value);
    if (this.failError) throw this.failError;
    return {
      activationId: value.activationId,
      attempt: value.attempt,
      acceptedJournalOffset: 12n,
      status: 'FAILED',
    };
  }
}

describe('durable activation V1 contract', () => {
  it.each(['user', 'sleep', 'budget'])('rejects a standalone context %s wait within an admitted activation', async wait => {
    const ctx = new ContextImpl('inv', 'run', 0, 'waits', { storage: 'memory', workerlessDeadlineMs: Date.now() });
    await expect(runWithActivation({ kind: 'EXECUTE', activationId: 'tool', attempt: 1, acceptedJournalOffset: 1n }, async () => {
      if (wait === 'user') return ctx.waitForUser('Continue?');
      if (wait === 'sleep') return ctx.sleep(1);
      return ctx.yieldIfNeeded();
    })).rejects.toMatchObject({ name: 'ConfigurationError' });
  });
  it('matches the frozen proto activation-kind values', () => {
    expect(ActivationKind.Step).toBe(1);
    expect(ActivationKind.Function).toBe(2);
    expect(ActivationKind.Agent).toBe(ActivationKind.Function);
    expect(ActivationKind.Model).toBe(3);
    expect(ActivationKind.Tool).toBe(4);
    expect(ActivationKind.Child).toBe(5);
  });

  it('derives stable immutable linkage for delegated children', async () => {
    const context = new ContextImpl('inv-1', 'run-1', 0, 'router', {
      metadata: {
        project_id: 'project-1',
        component_name: 'router',
        worker_session_id: 'worker-1',
        run_authority: 'run-authority',
        lease_authority: 'lease-authority',
        activation_definition_version: 'v1',
        activation_artifact_sha256: '00'.repeat(32),
        activation_definition_config: '["object",[]]',
      },
    });
    const child = await childActivationRequestFromContext(context, {
      childName: 'researcher',
      stableKey: 'child:researcher:0',
      input: { message: 'investigate' },
      joinPolicy: ChildJoinPolicy.Required,
    });

    expect(child.kind).toBe(ActivationKind.Child);
    expect(child.recoveryPolicy).toBe(ActivationRecoveryPolicy.DurableSteps);
    expect(child.child?.childKey).toBe(child.stableKey);
    expect(bytes(child.child!.childDefinitionDigest)).toEqual(bytes(child.definitionDigest));
    expect(child.child?.childRunId).toMatch(/^child_/);
    expect(child.child?.childSessionId).toMatch(/^session_/);
    expect(child.child?.joinPolicy).toBe(ChildJoinPolicy.Required);
    expect(child.displayName).toBe('researcher');
    expect(decodeInput(child.inputData)).toEqual({ message: 'investigate' });
  });

  it('names step and timer records and renders their bounded input', async () => {
    const metadata = {
      project_id: 'project-1',
      worker_session_id: 'worker-1',
      run_authority: 'run-authority',
      lease_authority: 'lease-authority',
      activation_definition_version: 'v1',
      activation_artifact_sha256: '00'.repeat(32),
      activation_definition_config: '["object",[]]',
    };
    const step = await stepActivationRequest({
      metadata,
      invocationId: 'inv-1',
      runId: 'run-1',
      componentName: 'workflow',
      stepName: 'load',
      ordinal: 3,
      input: { page: 2 },
    });
    expect(step.displayName).toBe('load');
    expect(decodeInput(step.inputData)).toEqual({
      step_name: 'load',
      step_key: 'step:load:3',
      input: { page: 2 },
    });

    const timer = await timerActivationRequest({
      metadata,
      invocationId: 'inv-1',
      runId: 'run-1',
      componentName: 'workflow',
      timerKey: 'sleep:backoff',
      delayMs: 2_500,
    });
    expect(timer.displayName).toBe('sleep:backoff');
    expect(decodeInput(timer.inputData)).toEqual({ delay_ms: 2_500, timer_key: 'sleep:backoff' });
  });

  it('caps record input at 64 KiB with a truncation marker', () => {
    expect(decodeInput(boundedInputData({ ok: true }))).toEqual({ ok: true });
    expect(boundedInputData(undefined)).toBeUndefined();
    const oversized = boundedInputData({ blob: 'x'.repeat(64 * 1024) })!;
    expect(oversized.byteLength).toBeLessThan(128);
    expect(decodeInput(oversized)).toMatchObject({ truncated: true });
  });

  it('maps structured native failures to typed activation errors', async () => {
    for (const code of [
      ActivationErrorCode.StaleAuthority,
      ActivationErrorCode.RequiredChildUnresolved,
    ]) {
      const transport = new NativeActivationTransport({
        beginActivation: vi.fn(async () => {
          throw new Error(
            'AGNT5_ACTIVATION_ERROR:' + JSON.stringify({
              code,
              message: 'lease was replaced',
              activationId: 'actv1_test',
              attempt: 2,
            }),
          );
        }),
        completeActivation: vi.fn(),
        failActivation: vi.fn(),
      });

      await expect(transport.begin(request())).rejects.toMatchObject({
        code,
        activationId: 'actv1_test',
        attempt: 2,
      });
    }
  });

  it('matches the frozen canonical vectors', async () => {
    const vectors: [unknown, string][] = [
      [null, '["null"]'],
      [true, '["bool",true]'],
      [-42, '["i64","-42"]'],
      [new UInt64(42n), '["u64","42"]'],
      [new Float64(1), '["f64","3ff0000000000000"]'],
      [new Float64(-0), '["f64","0000000000000000"]'],
      ['café/', '["string","café/"]'],
      [new Uint8Array([0, 255]), '["bytes","AP8"]'],
      [[null, false, 'x'], '["array",[["null"],["bool",false],["string","x"]]]'],
      [
        { name: 'alpha', count: 2 },
        '["object",[["count",["i64","2"]],["name",["string","alpha"]]]]',
      ],
    ];
    for (const [value, expected] of vectors) {
      expect(decoder.decode(canonicalActivationValue(value))).toBe(expected);
    }
    expect(bytes(await sha256(canonicalActivationValue(null)))).toHaveLength(32);
  });

  it('matches frozen definition and identity vectors', async () => {
    const definition = await activationDefinitionDigest(
      fromBase64('0lJSBAIElTtKmSY0S/XeONW7020B5x6yW0xopTX5kkg='),
      'workflow',
      'v1',
      encoder.encode('["object",[]]'),
    );
    expect(btoa(String.fromCharCode(...definition))).toBe(
      'iTziD0lZ9kXRtq7RUj58/nzuTDQQtdgYp+MDNrAGVmw=',
    );
    await expect(
      activationId('project-1', 'run-1', 'parent-1', ActivationKind.Step, 'step/load'),
    ).resolves.toBe('actv1_9LU0V32sQX2U3CaQSCW37t-WWSvBAe04qTWqTD6mN-w');
  });

  it.each([NaN, Infinity, -Infinity, 2n ** 63n, new Map(), '\ud800', undefined])(
    'rejects unsafe canonical input %s',
    value => {
      expect(() => canonicalActivationValue(value)).toThrow(ActivationError);
    },
  );

  it('provides explicit and sequential stable keys', () => {
    expect(stableStepKey('load', 0)).toBe('step:load:0');
    expect(stableStepKey('load', 0, 'item-42')).toBe('step:load:item-42');
  });

  it('executes only after admission and returns only after completion acceptance', async () => {
    const value = request();
    const id = await activationId(
      value.projectId,
      value.runId,
      value.parentActivationId,
      value.kind,
      value.stableKey,
    );
    const transport = new RecordingTransport({
      kind: 'EXECUTE',
      activationId: id,
      attempt: 1,
      acceptedJournalOffset: 11n,
      fenceToken: encoder.encode('fence-1'),
    });
    const execute = vi.fn(async () => ({ value: 42 }));
    const evidencePayload = encoder.encode('{"finishReason":"stop"}');
    const response = await new ActivationClient(transport).run(value, execute, {
      encodeOutput: output => encoder.encode(JSON.stringify(output)),
      decodeOutput: output => JSON.parse(decoder.decode(output)),
      latencyMs: () => 1,
      completionUsage: () => ({
        tokensIn: 3,
        tokensOut: 2,
        provider: 'openai',
        model: 'openai/gpt-test',
      }),
      completionEvidence: async () => [{
        evidenceType: 'provider_terminal',
        payload: evidencePayload,
        sha256: await sha256(evidencePayload),
      }],
    });

    expect(response.result).toEqual({ value: 42 });
    expect(execute).toHaveBeenCalledOnce();
    expect(transport.completeRequests).toHaveLength(1);
    expect(transport.completeRequests[0].outputDigest).toEqual(
      await sha256(encoder.encode('{"value":42}')),
    );
    expect(transport.completeRequests[0].usage).toMatchObject({
      tokensIn: 3,
      tokensOut: 2,
      latencyMs: 1,
      provider: 'openai',
      model: 'openai/gpt-test',
    });
    expect(transport.completeRequests[0].evidence[0].sha256).toEqual(
      await sha256(evidencePayload),
    );
  });

  it('replays without executing user code', async () => {
    const value = request();
    const id = await activationId(
      value.projectId,
      value.runId,
      value.parentActivationId,
      value.kind,
      value.stableKey,
    );
    const transport = new RecordingTransport({
      kind: 'REPLAY',
      activationId: id,
      attempt: 1,
      acceptedJournalOffset: 12n,
      replayOutput: encoder.encode('{"cached":true}'),
    });
    const execute = vi.fn();
    const response = await new ActivationClient(transport).run(value, execute, {
      encodeOutput: output => encoder.encode(JSON.stringify(output)),
      decodeOutput: output => JSON.parse(decoder.decode(output)),
      latencyMs: () => 0,
    });

    expect(response.result).toEqual({ cached: true });
    expect(execute).not.toHaveBeenCalled();
    expect(transport.completeRequests).toHaveLength(0);
  });

  it('does not return when the completion acknowledgement is lost', async () => {
    const value = request();
    const id = await activationId(
      value.projectId,
      value.runId,
      value.parentActivationId,
      value.kind,
      value.stableKey,
    );
    const transport = new RecordingTransport({
      kind: 'EXECUTE',
      activationId: id,
      attempt: 1,
      acceptedJournalOffset: 11n,
      fenceToken: encoder.encode('fence-1'),
    });
    transport.completeError = new ActivationError(
      ActivationErrorCode.UnknownOutcome,
      'completion acknowledgement was lost',
    );
    const execute = vi.fn(async () => 'value');

    await expect(new ActivationClient(transport).run(value, execute, {
      encodeOutput: output => encoder.encode(JSON.stringify(output)),
      decodeOutput: output => JSON.parse(decoder.decode(output)),
      latencyMs: () => 1,
    })).rejects.toMatchObject({ code: ActivationErrorCode.UnknownOutcome });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('waits for an accepted failure receipt before raising user code errors', async () => {
    const value = request();
    const id = await activationId(
      value.projectId,
      value.runId,
      value.parentActivationId,
      value.kind,
      value.stableKey,
    );
    const decision: ActivationDecision = {
      kind: 'EXECUTE',
      activationId: id,
      attempt: 1,
      acceptedJournalOffset: 11n,
      fenceToken: encoder.encode('fence-1'),
    };
    const transport = new RecordingTransport(decision);
    const execute = vi.fn(async () => { throw new Error('boom'); });

    await expect(new ActivationClient(transport).run(value, execute, {
      encodeOutput: output => encoder.encode(JSON.stringify(output)),
      decodeOutput: output => JSON.parse(decoder.decode(output)),
      latencyMs: () => 1,
    })).rejects.toThrow('boom');
    expect(transport.failRequests).toHaveLength(1);
    expect(transport.failRequests[0].externalOutcomeCertainty).toBe('UNKNOWN');

    const lostTransport = new RecordingTransport(decision);
    lostTransport.failError = new ActivationError(
      ActivationErrorCode.UnknownOutcome,
      'failure acknowledgement was lost',
    );
    await expect(new ActivationClient(lostTransport).run(value, execute, {
      encodeOutput: output => encoder.encode(JSON.stringify(output)),
      decodeOutput: output => JSON.parse(decoder.decode(output)),
      latencyMs: () => 1,
    })).rejects.toMatchObject({ code: ActivationErrorCode.UnknownOutcome });
  });

  it.each([
    ActivationErrorCode.InvalidArgument, ActivationErrorCode.NonDeterministicReplay,
    ActivationErrorCode.PayloadConflict, ActivationErrorCode.IllegalTransition,
    ActivationErrorCode.ReferenceRequired, ActivationErrorCode.StateVersionConflict,
    ActivationErrorCode.DurabilityUnavailable,
  ])('fails the admitted parent for a hard nested %s error', async code => {
    const value = request();
    const id = await activationId(value.projectId, value.runId, value.parentActivationId, value.kind, value.stableKey);
    const transport = new RecordingTransport({ kind: 'EXECUTE', activationId: id, attempt: 1, acceptedJournalOffset: 11n, fenceToken: encoder.encode('fence') });
    const error = new ActivationError(code, 'nested activation failed');
    await expect(new ActivationClient(transport).run(value, async () => { throw error; }, {
      encodeOutput: output => encoder.encode(JSON.stringify(output)),
      decodeOutput: output => JSON.parse(decoder.decode(output)), latencyMs: () => 1,
    })).rejects.toBe(error);
    expect(transport.failRequests).toHaveLength(1);
    expect(transport.failRequests[0]).toMatchObject({ activationId: id, retryable: false });
    expect(transport.completeRequests).toHaveLength(0);
  });

  it.each([ActivationErrorCode.Contended, ActivationErrorCode.StaleAuthority, ActivationErrorCode.Cancelled, ActivationErrorCode.UnknownOutcome, ActivationErrorCode.RequiredChildUnresolved])('does not fail an admitted parent on runtime-owned %s interruption', async code => {
    const value = request();
    const id = await activationId(value.projectId, value.runId, value.parentActivationId, value.kind, value.stableKey);
    const transport = new RecordingTransport({ kind: 'EXECUTE', activationId: id, attempt: 1, acceptedJournalOffset: 11n, fenceToken: encoder.encode('fence') });
    const error = new ActivationError(code, 'runtime must resolve this activation');
    await expect(new ActivationClient(transport).run(value, async () => { throw error; }, {
      encodeOutput: output => encoder.encode(JSON.stringify(output)),
      decodeOutput: output => JSON.parse(decoder.decode(output)), latencyMs: () => 1,
    })).rejects.toBe(error);
    expect(transport.failRequests).toHaveLength(0);
    expect(transport.completeRequests).toHaveLength(0);
  });

  it.each([
    ['WAIT', ActivationErrorCode.Contended],
    ['CONFLICT', ActivationErrorCode.NonDeterministicReplay],
    ['CANCELLED', ActivationErrorCode.Cancelled],
    ['UNKNOWN_OUTCOME', ActivationErrorCode.UnknownOutcome],
  ] as const)('refuses %s without executing', async (kind, code) => {
    const value = request();
    const id = await activationId(
      value.projectId,
      value.runId,
      value.parentActivationId,
      value.kind,
      value.stableKey,
    );
    const execute = vi.fn();
    const transport = new RecordingTransport({
      kind,
      activationId: id,
      attempt: 1,
      acceptedJournalOffset: 11n,
    });
    try {
      await new ActivationClient(transport).run(value, execute, {
        encodeOutput: output => encoder.encode(JSON.stringify(output)),
        decodeOutput: output => JSON.parse(decoder.decode(output)),
        latencyMs: () => 0,
      });
      throw new Error('expected activation error');
    } catch (error) {
      expect(error).toBeInstanceOf(ActivationError);
      expect((error as ActivationError).code).toBe(code);
    }
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('step input', () => {
  const metadata = {
    project_id: 'project-1',
    worker_session_id: 'worker-1',
    run_authority: 'run-authority',
    lease_authority: 'lease-authority',
    activation_definition_version: 'v1',
    activation_artifact_sha256: '00'.repeat(32),
    activation_definition_config: '["object",[]]',
  };
  const step = (input?: unknown) => stepActivationRequest({
    metadata,
    invocationId: 'inv-1',
    runId: 'run-1',
    componentName: 'workflow',
    stepName: 'load',
    ordinal: 0,
    input,
  });
  const digest = async (input?: unknown) => btoa(String.fromCharCode(...(await step(input)).inputDigest));

  it('digests no input as null and a given input like Go does', async () => {
    // Existing steps without an input keep sending the digest of null.
    expect(await digest()).toBe(btoa(String.fromCharCode(...await sha256(encoder.encode('["null"]')))));
    // The Go SDK's frozen vector for the same value.
    expect(await digest({ name: 'alpha', count: 2 })).toBe('+6akLLE8ses5QeK62PHHkobScg7gWMdae1Zh105nCzM=');
  });

  it('drops undefined properties from the hashed input', async () => {
    expect(await digest({ name: 'alpha', count: 2, note: undefined }))
      .toBe(await digest({ name: 'alpha', count: 2 }));
    expect(await digest({ order: { id: 'o-1', coupon: undefined }, items: [{ sku: 'a', gift: undefined }] }))
      .toBe(await digest({ order: { id: 'o-1' }, items: [{ sku: 'a' }] }));
    expect(decodeInput((await step({ at: '2026-10-08', skip: undefined })).inputData)).toEqual({
      step_name: 'load',
      step_key: 'step:load:0',
      input: { at: '2026-10-08' },
    });
  });

  it('gives a local step body the input with undefined properties dropped', async () => {
    const ctx = new ContextImpl('inv', 'run', 0, 'local', { storage: 'memory' });
    const input: { amount: number; note?: string } = { amount: 2, note: undefined };
    const pending = ctx.step('double', value => ({ doubled: value.amount * 2, keys: Object.keys(value) }), { input });
    input.amount = 9;
    await expect(pending).resolves.toEqual({ doubled: 4, keys: ['amount'] });
  });

  it('leaves inputs the canonical encoding accepts as they are', () => {
    const accepted: unknown[] = [
      { name: 'alpha', count: 2, nested: [true, 'x', null] },
      { bytes: new Uint8Array([0, 255]), big: 2n, u: new UInt64(42n), f: new Float64(1) },
      JSON.parse('{"__proto__": {"a": 1}, "b": 2}'),
      Object.assign(Object.create(null), { a: 1 }),
    ];
    for (const value of accepted) {
      expect(decoder.decode(canonicalActivationValue(normalizeStepInput(value))))
        .toBe(decoder.decode(canonicalActivationValue(value)));
    }
  });

  it('copies bytes into the snapshot and keeps a Buffer a Buffer', () => {
    const bytes = new Uint8Array([1, 2]);
    const buffer = Buffer.from([3, 4]);
    const copy = normalizeStepInput({ bytes, buffer }) as { bytes: Uint8Array; buffer: Buffer };
    bytes[0] = 9;
    buffer[0] = 9;
    expect([...copy.bytes]).toEqual([1, 2]);
    expect(Buffer.isBuffer(copy.buffer)).toBe(true);
    expect(copy.buffer.toString('hex')).toBe('0304');
  });

  it('shares numeric wrappers with the snapshot because they cannot change', () => {
    const u = new UInt64(42n);
    const f = new Float64(1.5);
    const copy = normalizeStepInput({ u, f }) as { u: UInt64; f: Float64 };
    expect(() => { (u as { value: bigint }).value = 1n; }).toThrow(TypeError);
    expect(() => { (f as { value: number }).value = 2; }).toThrow(TypeError);
    expect(copy.u.value).toBe(42n);
    expect(copy.f.value).toBe(1.5);
  });

  // eslint-disable-next-line no-sparse-arrays
  it.each([new Date(0), [1, undefined], [1, , 3], new Map([['a', 1]]), new Set([1]), { run: () => 1 }, new (class Order {})()])(
    'rejects an input it cannot hash faithfully: %s',
    async value => {
      await expect(step(value)).rejects.toBeInstanceOf(ActivationError);
    },
  );
});
