import { ActivationError, ActivationErrorCode } from './errors.js';

export const DURABLE_ACTIVATION_V1 = 'durable_activation_v1';
const IDENTITY_DOMAIN = utf8('agnt5.activation.identity.v1\0');
const DEFINITION_DOMAIN = utf8('agnt5.activation.definition.v1\0');
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const U64_MAX = 2n ** 64n - 1n;
const NATIVE_ACTIVATION_ERROR_PREFIX = 'AGNT5_ACTIVATION_ERROR:';

function nativeActivationError(error: unknown): ActivationError {
  if (error instanceof ActivationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const marker = message.indexOf(NATIVE_ACTIVATION_ERROR_PREFIX);
  if (marker >= 0) {
    try {
      const detail = JSON.parse(
        message.slice(marker + NATIVE_ACTIVATION_ERROR_PREFIX.length),
      ) as {
        code?: string;
        message?: string;
        activationId?: string;
        attempt?: number;
      };
      const knownCodes = new Set<string>(Object.values(ActivationErrorCode));
      const code = knownCodes.has(detail.code || '')
        ? detail.code as (typeof ActivationErrorCode)[keyof typeof ActivationErrorCode]
        : ActivationErrorCode.UnknownOutcome;
      return new ActivationError(
        code,
        detail.message || message,
        detail.activationId || '',
        Number(detail.attempt || 0),
      );
    } catch {
      // Fall through to an unknown-outcome error with the original message.
    }
  }
  return new ActivationError(ActivationErrorCode.UnknownOutcome, message);
}

export class UInt64 {
  readonly value: bigint;

  constructor(value: bigint | number) {
    const converted = BigInt(value);
    if (converted < 0n || converted > U64_MAX) {
      throw new RangeError('UInt64 must be between 0 and 2^64 - 1');
    }
    this.value = converted;
  }
}

export class Float64 {
  readonly value: number;

  constructor(value: number) {
    if (!Number.isFinite(value)) {
      throw new RangeError('Float64 must be finite');
    }
    this.value = value;
  }
}

export enum ActivationKind {
  Step = 1,
  Function = 2,
  Agent = Function,
  Model = 3,
  Tool = 4,
  Child = 5,
  Approval = 6,
  Timer = 7,
  Eval = 8,
}

export enum ActivationRecoveryPolicy {
  IdempotentRetry = 1,
  DurableSteps = 2,
  UnknownOutcome = 3,
  Compensate = 4,
  Fail = 5,
}

export type ActivationDecisionKind =
  | 'EXECUTE'
  | 'REPLAY'
  | 'WAIT'
  | 'CONFLICT'
  | 'CANCELLED'
  | 'UNKNOWN_OUTCOME';

export interface BeginActivationRequest {
  projectId: string;
  runId: string;
  parentActivationId: string;
  kind: ActivationKind;
  stableKey: string;
  inputDigest: Uint8Array;
  definitionDigest: Uint8Array;
  recoveryPolicy: ActivationRecoveryPolicy;
  workerSessionId: string;
  runAuthority: Uint8Array;
  leaseAuthority: Uint8Array;
}

export interface ActivationDecision {
  kind: ActivationDecisionKind;
  activationId: string;
  attempt: number;
  acceptedJournalOffset: bigint;
  fenceToken?: Uint8Array;
  replayOutput?: Uint8Array;
  message?: string;
}

export interface ActivationCompletionReceipt {
  activationId: string;
  attempt: number;
  acceptedJournalOffset: bigint;
  replayed?: boolean;
}

export interface ActivationFailureReceipt {
  activationId: string;
  attempt: number;
  acceptedJournalOffset: bigint;
  status: string;
  replayed?: boolean;
}

export interface ActivationTransport {
  begin(request: BeginActivationRequest): Promise<ActivationDecision>;
  complete(request: {
    projectId: string;
    runId: string;
    activationId: string;
    attempt: number;
    fenceToken: Uint8Array;
    output: Uint8Array;
    outputDigest: Uint8Array;
    latencyMs: number;
  }): Promise<ActivationCompletionReceipt>;
  fail(request: {
    projectId: string;
    runId: string;
    activationId: string;
    attempt: number;
    fenceToken: Uint8Array;
    errorCode: string;
    errorData: Uint8Array;
    retryable: boolean;
    externalOutcomeCertainty: 'UNKNOWN';
  }): Promise<ActivationFailureReceipt>;
}

export class NativeActivationTransport implements ActivationTransport {
  constructor(private readonly nativeWorker: any) {
    for (const method of ['beginActivation', 'completeActivation', 'failActivation']) {
      if (typeof nativeWorker?.[method] !== 'function') {
        throw new ActivationError(
          ActivationErrorCode.DurabilityUnavailable,
          `runtime negotiated durable_activation_v1 but native worker method ${method} is unavailable`,
        );
      }
    }
  }

  async begin(request: BeginActivationRequest): Promise<ActivationDecision> {
    let response: any;
    try {
      response = await this.nativeWorker.beginActivation(request);
    } catch (error) {
      throw nativeActivationError(error);
    }
    return {
      kind: response.kind,
      activationId: response.activationId,
      attempt: Number(response.attempt),
      acceptedJournalOffset: BigInt(response.acceptedJournalOffset),
      fenceToken: optionalBytes(response.fenceToken),
      replayOutput: optionalBytes(response.replayOutput),
      message: response.message,
    };
  }

  async complete(request: Parameters<ActivationTransport['complete']>[0]) {
    let response: any;
    try {
      response = await this.nativeWorker.completeActivation(request);
    } catch (error) {
      throw nativeActivationError(error);
    }
    return {
      activationId: response.activationId,
      attempt: Number(response.attempt),
      acceptedJournalOffset: BigInt(response.acceptedJournalOffset),
      replayed: Boolean(response.replayed),
    };
  }

  async fail(request: Parameters<ActivationTransport['fail']>[0]) {
    let response: any;
    try {
      response = await this.nativeWorker.failActivation(request);
    } catch (error) {
      throw nativeActivationError(error);
    }
    return {
      activationId: response.activationId,
      attempt: Number(response.attempt),
      acceptedJournalOffset: BigInt(response.acceptedJournalOffset),
      status: response.status,
      replayed: Boolean(response.replayed),
    };
  }
}

export interface StepActivationRequestOptions {
  metadata: Record<string, string>;
  invocationId: string;
  runId: string;
  componentName: string;
  stepName: string;
  ordinal: number;
  explicitKey?: string;
  input?: unknown;
}

export interface TimerActivationRequestOptions {
  metadata: Record<string, string>;
  invocationId: string;
  runId: string;
  componentName: string;
  timerKey: string;
  delayMs: number;
}

export async function stepActivationRequest(
  options: StepActivationRequestOptions,
): Promise<BeginActivationRequest> {
  const { metadata } = options;
  const projectId = metadata.project_id || metadata.tenant_id || '';
  const workerSessionId = metadata.worker_session_id || metadata.worker_id || '';
  const runAuthority = metadata.run_authority || options.invocationId;
  const leaseAuthority = metadata.lease_authority || metadata.lease_id || '';
  const definitionVersion = metadata.activation_definition_version || '';
  if (!projectId || !options.runId || !workerSessionId || !runAuthority ||
      !leaseAuthority || !options.componentName || !definitionVersion) {
    throw new ActivationError(
      ActivationErrorCode.DurabilityUnavailable,
      'durable activation requires project, run, worker-session, run, lease, and definition authority',
    );
  }
  const canonicalConfig = utf8(
    metadata.activation_definition_config || '["object",[]]',
  );
  return {
    projectId,
    runId: options.runId,
    parentActivationId: metadata.parent_activation_id || '',
    kind: ActivationKind.Step,
    stableKey: stableStepKey(options.stepName, options.ordinal, options.explicitKey),
    inputDigest: await sha256(canonicalActivationValue(options.input ?? null)),
    definitionDigest: await activationDefinitionDigest(
      decodeSha256(metadata.activation_artifact_sha256 || ''),
      options.componentName,
      definitionVersion,
      canonicalConfig,
    ),
    recoveryPolicy: ActivationRecoveryPolicy.DurableSteps,
    workerSessionId,
    runAuthority: utf8(runAuthority),
    leaseAuthority: utf8(leaseAuthority),
  };
}

export async function timerActivationRequest(
  options: TimerActivationRequestOptions,
): Promise<BeginActivationRequest> {
  const { metadata } = options;
  const projectId = metadata.project_id || metadata.tenant_id || '';
  const workerSessionId = metadata.worker_session_id || metadata.worker_id || '';
  const runAuthority = metadata.run_authority || options.invocationId;
  const leaseAuthority = metadata.lease_authority || metadata.lease_id || '';
  const definitionVersion = metadata.activation_definition_version || '';
  if (!projectId || !options.runId || !workerSessionId || !runAuthority ||
      !leaseAuthority || !options.componentName || !definitionVersion) {
    throw new ActivationError(
      ActivationErrorCode.DurabilityUnavailable,
      'durable timer requires project, run, worker-session, run, lease, and definition authority',
    );
  }
  const canonicalConfig = utf8(
    metadata.activation_definition_config || '["object",[]]',
  );
  return {
    projectId,
    runId: options.runId,
    parentActivationId: metadata.parent_activation_id || '',
    kind: ActivationKind.Timer,
    stableKey: options.timerKey,
    inputDigest: await sha256(canonicalActivationValue({
      delay_ms: options.delayMs,
      timer_key: options.timerKey,
    })),
    definitionDigest: await activationDefinitionDigest(
      decodeSha256(metadata.activation_artifact_sha256 || ''),
      options.componentName,
      definitionVersion,
      canonicalConfig,
    ),
    recoveryPolicy: ActivationRecoveryPolicy.DurableSteps,
    workerSessionId,
    runAuthority: utf8(runAuthority),
    leaseAuthority: utf8(leaseAuthority),
  };
}

export interface ActivationRunOptions<T> {
  encodeOutput(value: T): Uint8Array;
  decodeOutput(value: Uint8Array): T;
  latencyMs(): number;
  onAdmitted?(decision: ActivationDecision): void | Promise<void>;
  onCompleted?(
    decision: ActivationDecision,
    receipt: ActivationDecision | ActivationCompletionReceipt,
    result: T,
  ): void | Promise<void>;
  onFailed?(
    decision: ActivationDecision,
    receipt: ActivationFailureReceipt,
    error: unknown,
  ): void | Promise<void>;
}

export class ActivationClient {
  constructor(private readonly transport: ActivationTransport) {}

  async begin(request: BeginActivationRequest): Promise<ActivationDecision> {
    const expectedId = await activationId(
      request.projectId,
      request.runId,
      request.parentActivationId,
      request.kind,
      request.stableKey,
    );
    const decision = await this.transport.begin(request);
    if (decision.activationId !== expectedId) {
      throw new ActivationError(
        ActivationErrorCode.UnknownOutcome,
        `runtime returned activation ID ${JSON.stringify(decision.activationId)}, expected ${JSON.stringify(expectedId)}`,
        decision.activationId,
        decision.attempt,
      );
    }
    if (decision.kind === 'EXECUTE' &&
        (decision.attempt <= 0 || !decision.fenceToken?.length)) {
      throw new ActivationError(
        ActivationErrorCode.UnknownOutcome,
        'EXECUTE receipt is missing fenced authority',
        decision.activationId,
        decision.attempt,
      );
    }
    return decision;
  }

  async run<T>(
    request: BeginActivationRequest,
    execute: () => T | Promise<T>,
    options: ActivationRunOptions<T>,
  ): Promise<{ result: T; receipt: ActivationDecision | ActivationCompletionReceipt }> {
    const decision = await this.begin(request);
    if (decision.kind === 'REPLAY') {
      if (!decision.replayOutput) {
        throw new ActivationError(
          ActivationErrorCode.UnknownOutcome,
          'REPLAY receipt is missing its canonical output',
          decision.activationId,
          decision.attempt,
        );
      }
      await options.onAdmitted?.(decision);
      const result = options.decodeOutput(decision.replayOutput);
      await options.onCompleted?.(decision, decision, result);
      return { result, receipt: decision };
    }
    if (decision.kind !== 'EXECUTE') {
      throw activationDecisionError(decision);
    }
    const fenceToken = decision.fenceToken!;
    await options.onAdmitted?.(decision);

    let result: T;
    try {
      result = await execute();
    } catch (error) {
      const errorData = utf8(JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
        type: error instanceof Error ? error.constructor.name : typeof error,
      }));
      const receipt = await this.transport.fail({
        projectId: request.projectId,
        runId: request.runId,
        activationId: decision.activationId,
        attempt: decision.attempt,
        fenceToken,
        errorCode: 'STEP_FAILED',
        errorData,
        retryable: false,
        externalOutcomeCertainty: 'UNKNOWN',
      });
      validateReceiptAuthority(decision, receipt, 'failure');
      await options.onFailed?.(decision, receipt, error);
      throw error;
    }

    const output = options.encodeOutput(result);
    const receipt = await this.transport.complete({
      projectId: request.projectId,
      runId: request.runId,
      activationId: decision.activationId,
      attempt: decision.attempt,
      fenceToken,
      output,
      outputDigest: await sha256(output),
      latencyMs: options.latencyMs(),
    });
    validateReceiptAuthority(decision, receipt, 'completion');
    await options.onCompleted?.(decision, receipt, result);
    return { result, receipt };
  }
}

export function canonicalActivationValue(value: unknown): Uint8Array {
  return utf8(JSON.stringify(canonicalValue(value)));
}

export async function activationDefinitionDigest(
  artifactSha256: Uint8Array,
  componentName: string,
  definitionVersion: string,
  canonicalConfig: Uint8Array,
): Promise<Uint8Array> {
  if (artifactSha256.length !== 32) {
    throw new ActivationError(
      ActivationErrorCode.InvalidArgument,
      'activation artifact SHA-256 must contain exactly 32 bytes',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(canonicalConfig));
  } catch (error) {
    throw new ActivationError(
      ActivationErrorCode.InvalidArgument,
      'activation definition config is not valid canonical JSON',
    );
  }
  if (!bytesEqual(utf8(JSON.stringify(parsed)), canonicalConfig)) {
    throw new ActivationError(
      ActivationErrorCode.InvalidArgument,
      'activation definition config is not canonically encoded',
    );
  }
  return sha256(concatBytes(
    DEFINITION_DOMAIN,
    ...[
      artifactSha256,
      utf8(componentName),
      utf8(definitionVersion),
      utf8(DURABLE_ACTIVATION_V1),
      canonicalConfig,
    ].map(frame),
  ));
}

export async function activationId(
  projectId: string,
  runId: string,
  parentActivationId: string,
  kind: ActivationKind,
  stableKey: string,
): Promise<string> {
  const kindBytes = new Uint8Array(4);
  new DataView(kindBytes.buffer).setUint32(0, kind, false);
  const encoded = concatBytes(
    IDENTITY_DOMAIN,
    frame(utf8(projectId)),
    frame(utf8(runId)),
    frame(utf8(parentActivationId)),
    kindBytes,
    frame(utf8(stableKey)),
  );
  return `actv1_${base64Url(await sha256(encoded))}`;
}

export function stableStepKey(stepName: string, ordinal: number, explicitKey?: string): string {
  if (!stepName) {
    throw new ActivationError(ActivationErrorCode.InvalidArgument, 'step name cannot be empty');
  }
  if (explicitKey !== undefined) {
    if (!explicitKey) {
      throw new ActivationError(
        ActivationErrorCode.InvalidArgument,
        'explicit step key cannot be empty',
      );
    }
    return `step:${stepName}:${explicitKey}`;
  }
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new ActivationError(
      ActivationErrorCode.InvalidArgument,
      'sequential step ordinal must be a non-negative safe integer',
    );
  }
  return `step:${stepName}:${ordinal}`;
}

export function decodeSha256(value: string): Uint8Array {
  if (!value) {
    throw new ActivationError(
      ActivationErrorCode.DurabilityUnavailable,
      'activation artifact SHA-256 is unavailable',
    );
  }
  let decoded: Uint8Array | undefined;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    decoded = Uint8Array.from(value.match(/../g)!, part => Number.parseInt(part, 16));
  } else {
    try {
      const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
      decoded = Uint8Array.from(atob(padded), char => char.charCodeAt(0));
    } catch {
      decoded = undefined;
    }
  }
  if (decoded?.length === 32) return decoded;
  throw new ActivationError(
    ActivationErrorCode.InvalidArgument,
    'activation artifact SHA-256 must encode exactly 32 bytes',
  );
}

export async function sha256(value: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new ActivationError(
      ActivationErrorCode.DurabilityUnavailable,
      'Web Crypto SHA-256 is unavailable in this JavaScript runtime',
    );
  }
  return new Uint8Array(await subtle.digest('SHA-256', value));
}

function canonicalValue(value: unknown): unknown[] {
  if (value === null) return ['null'];
  if (typeof value === 'boolean') return ['bool', value];
  if (value instanceof UInt64) return ['u64', value.value.toString()];
  if (value instanceof Float64) return canonicalFloat64(value.value);
  if (typeof value === 'bigint') {
    if (value < I64_MIN || value > I64_MAX) {
      throw invalidValue('canonical activation bigint exceeds signed 64-bit range');
    }
    return ['i64', value.toString()];
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw invalidValue('canonical activation values reject NaN and infinity');
    }
    if (Object.is(value, -0)) return canonicalFloat64(value);
    if (Number.isSafeInteger(value)) return ['i64', value.toString()];
    return canonicalFloat64(value);
  }
  if (typeof value === 'string') {
    validateUnicode(value);
    return ['string', value];
  }
  if (value instanceof Uint8Array) return ['bytes', base64Url(value)];
  if (Array.isArray(value)) return ['array', value.map(canonicalValue)];
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidValue(`unsupported canonical activation value type ${prototype?.constructor?.name ?? 'object'}`);
    }
    const record = value as Record<string, unknown>;
    return ['object', Object.keys(record).sort().map(key => {
      validateUnicode(key);
      return [key, canonicalValue(record[key])];
    })];
  }
  throw invalidValue(`unsupported canonical activation value type ${typeof value}`);
}

export function activationDecisionError(decision: ActivationDecision): ActivationError {
  const codes: Record<Exclude<ActivationDecisionKind, 'EXECUTE' | 'REPLAY'>, ActivationErrorCode> = {
    WAIT: ActivationErrorCode.Contended,
    CONFLICT: ActivationErrorCode.NonDeterministicReplay,
    CANCELLED: ActivationErrorCode.Cancelled,
    UNKNOWN_OUTCOME: ActivationErrorCode.UnknownOutcome,
  };
  const messages: Record<Exclude<ActivationDecisionKind, 'EXECUTE' | 'REPLAY'>, string> = {
    WAIT: 'activation is already executing',
    CONFLICT: 'stable step key was reused with different input or definition',
    CANCELLED: 'activation was cancelled',
    UNKNOWN_OUTCOME: 'activation has an unknown external outcome',
  };
  const kind = decision.kind as Exclude<ActivationDecisionKind, 'EXECUTE' | 'REPLAY'>;
  return new ActivationError(
    codes[kind] ?? ActivationErrorCode.UnknownOutcome,
    decision.message || messages[kind] || 'runtime returned an invalid decision',
    decision.activationId,
    decision.attempt,
  );
}

function validateReceiptAuthority(
  decision: ActivationDecision,
  receipt: ActivationCompletionReceipt | ActivationFailureReceipt,
  receiptKind: string,
): void {
  if (receipt.activationId !== decision.activationId || receipt.attempt !== decision.attempt) {
    throw new ActivationError(
      ActivationErrorCode.UnknownOutcome,
      `runtime returned a ${receiptKind} receipt for different activation authority`,
      decision.activationId,
      decision.attempt,
    );
  }
}

function invalidValue(message: string): ActivationError {
  return new ActivationError(ActivationErrorCode.InvalidArgument, message);
}

function canonicalFloat64(value: number): unknown[] {
  const bits = new Uint8Array(8);
  const view = new DataView(bits.buffer);
  view.setFloat64(0, value === 0 ? 0 : value, false);
  return ['f64', [...bits].map(byte => byte.toString(16).padStart(2, '0')).join('')];
}

function validateUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) {
        throw invalidValue('canonical activation strings must contain valid UTF-8');
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw invalidValue('canonical activation strings must contain valid UTF-8');
    }
  }
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function frame(value: Uint8Array): Uint8Array {
  const length = new Uint8Array(8);
  new DataView(length.buffer).setBigUint64(0, BigInt(value.length), false);
  return concatBytes(length, value);
}

function concatBytes(...values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((length, value) => length + value.length, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

function base64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function optionalBytes(value: unknown): Uint8Array | undefined {
  if (value === undefined || value === null) return undefined;
  return value instanceof Uint8Array ? value : Uint8Array.from(value as ArrayLike<number>);
}
