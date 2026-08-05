import { describe, expect, it, vi } from 'vitest';
import {
  ActivationClient,
  ActivationDecision,
  ActivationKind,
  ActivationRecoveryPolicy,
  ActivationTransport,
  BeginActivationRequest,
  Float64,
  NativeActivationTransport,
  UInt64,
  activationDefinitionDigest,
  activationId,
  canonicalActivationValue,
  sha256,
  stableStepKey,
} from '../activation.js';
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
  };
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
  it('maps structured native failures to typed activation errors', async () => {
    const transport = new NativeActivationTransport({
      beginActivation: vi.fn(async () => {
        throw new Error(
          'AGNT5_ACTIVATION_ERROR:' + JSON.stringify({
            code: ActivationErrorCode.StaleAuthority,
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
      code: ActivationErrorCode.StaleAuthority,
      activationId: 'actv1_test',
      attempt: 2,
    });
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
    const response = await new ActivationClient(transport).run(value, execute, {
      encodeOutput: output => encoder.encode(JSON.stringify(output)),
      decodeOutput: output => JSON.parse(decoder.decode(output)),
      latencyMs: () => 1,
    });

    expect(response.result).toEqual({ value: 42 });
    expect(execute).toHaveBeenCalledOnce();
    expect(transport.completeRequests).toHaveLength(1);
    expect(transport.completeRequests[0].outputDigest).toEqual(
      await sha256(encoder.encode('{"value":42}')),
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
