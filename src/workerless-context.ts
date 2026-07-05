import { SuspensionRequestedError, WaitingForUserInputError } from './errors.js';
import type { HITLInputType, HITLOption } from './errors.js';
import { emptyRuntimeContext } from './runtime-context.js';
import type { RuntimeContext } from './runtime-context.js';
import type { Context, Logger } from './types.js';

export interface WorkerlessContextOptions {
  checkpoints?: Record<string, unknown>;
  runtime?: RuntimeContext;
  workerlessDeadlineMs?: number;
  workerlessYieldBeforeMs?: number;
  metadata?: Record<string, string>;
}

export interface WorkerlessEmittedEvent {
  event_type: string;
  data: unknown;
  metadata?: Record<string, string>;
  timestamp_ns?: number;
  correlation_id?: string;
  parent_event_id?: string;
  step_key?: string;
  data_type?: string;
}

export class WorkerlessContext implements Context {
  private readonly state = new Map<string, unknown>();
  private readonly checkpoints = new Map<string, unknown>();
  private readonly initialStepCheckpointKeys = new Set<string>();
  private readonly visitedStepCheckpointKeys = new Set<string>();
  private readonly warnedStepCheckpointKeys = new Set<string>();
  private readonly emittedEvents: WorkerlessEmittedEvent[] = [];
  private readonly workerlessDeadlineMs?: number;
  private readonly workerlessYieldBeforeMs: number;
  private pauseIndex = 0;
  private readonly userResponses = new Map<number, string | null>();
  private readonly signalResponses = new Map<string, unknown>();
  readonly metadata?: Record<string, string>;
  readonly runtime: RuntimeContext;
  readonly signal: AbortSignal = new AbortController().signal;

  constructor(
    public readonly invocationId: string,
    public readonly runId: string,
    public readonly attempt: number,
    public readonly serviceName: string,
    options: WorkerlessContextOptions = {},
  ) {
    this.runtime = options.runtime ?? emptyRuntimeContext();
    this.metadata = options.metadata ? { ...options.metadata } : undefined;
    this.workerlessDeadlineMs = options.workerlessDeadlineMs;
    this.workerlessYieldBeforeMs = options.workerlessYieldBeforeMs ?? 1000;
    for (const [key, value] of Object.entries(options.checkpoints || {})) {
      this.checkpoints.set(key, value);
      if (key.startsWith('step:')) {
        this.initialStepCheckpointKeys.add(key);
      }
    }
    this.loadReplayState(options.metadata);
  }

  async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
    const value = this.state.get(key);
    return value !== undefined ? value as T : defaultValue;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.state.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.state.delete(key);
  }

  async step<T>(stepName: string, fn: () => T | Promise<T>): Promise<T> {
    const checkpointKey = `step:${stepName}`;
    this.visitedStepCheckpointKeys.add(checkpointKey);
    const existingCheckpoint = this.checkpoints.get(checkpointKey);
    if (existingCheckpoint !== undefined) {
      return existingCheckpoint as T;
    }
    this.warnIfPotentialUnsafeStepChange(stepName, checkpointKey);

    const result = await fn();
    this.checkpoints.set(checkpointKey, result);
    return result;
  }

  async yieldIfNeeded(reason = 'budget'): Promise<void> {
    if (!this.workerlessDeadlineMs) {
      return;
    }
    if (Date.now() + this.workerlessYieldBeforeMs < this.workerlessDeadlineMs) {
      return;
    }
    throw new SuspensionRequestedError({
      runId: this.runId,
      reason,
      checkpointState: this.checkpointSnapshot(),
      deadlineMs: this.workerlessDeadlineMs,
    });
  }

  async sleep(durationMs: number, name?: string): Promise<void> {
    validateSleepDuration(durationMs);
    if (durationMs === 0) {
      return;
    }

    const timerKey = name || `sleep_${durationMs}ms`;
    const startedAtMs = await this.step(timerKey, () => Date.now());
    if (!Number.isSafeInteger(startedAtMs)) {
      throw new Error(`sleep checkpoint '${timerKey}' must be a safe integer timestamp`);
    }
    const readyAtMs = (startedAtMs as number) + durationMs;
    if (Date.now() >= readyAtMs) {
      return;
    }

    throw new SuspensionRequestedError({
      runId: this.runId,
      reason: 'timer',
      checkpointState: this.checkpointSnapshot(),
      readyAtMs,
      timerKey,
    });
  }

  async waitForUser(
    question: string,
    options?: {
      inputType?: HITLInputType;
      options?: HITLOption[];
      allowCustom?: boolean;
      skippable?: boolean;
    },
  ): Promise<string | null> {
    const pauseIndex = this.pauseIndex++;
    if (this.userResponses.has(pauseIndex)) {
      return this.userResponses.get(pauseIndex)!;
    }

    const stepName = `wait_for_user_${pauseIndex}`;
    throw new WaitingForUserInputError({
      runId: this.runId,
      question,
      inputType: options?.inputType,
      options: options?.options,
      pauseIndex,
      allowCustom: options?.allowCustom,
      skippable: options?.skippable,
      checkpointState: this.checkpointSnapshot(),
      stepName,
      stepEvents: this.stepEventsSnapshot(),
    });
  }

  async waitForSignal<T = unknown>(signalName: string, name?: string): Promise<T> {
    const waitingStep = name || signalName;
    const responseKey = `${signalName}:${waitingStep}`;
    if (this.signalResponses.has(responseKey)) {
      return this.signalResponses.get(responseKey) as T;
    }

    throw new SuspensionRequestedError({
      runId: this.runId,
      reason: 'signal',
      checkpointState: this.checkpointSnapshot(),
      signalName,
      waitingStep,
    });
  }

  checkpointSnapshot(): Record<string, unknown> {
    return Object.fromEntries(this.checkpoints.entries());
  }

  setCheckpoint(key: string, value: unknown): void {
    this.checkpoints.set(key, value);
  }

  eventsSnapshot(): WorkerlessEmittedEvent[] {
    return this.emittedEvents.map((event) => ({
      ...event,
      metadata: event.metadata ? { ...event.metadata } : undefined,
    }));
  }

  private loadReplayState(metadata?: Record<string, string>): void {
    if (!metadata) {
      return;
    }

    const stepEventsStr = metadata.step_events;
    if (stepEventsStr) {
      try {
        const parsed = JSON.parse(stepEventsStr) as Record<string, string | null>;
        for (const [idxStr, value] of Object.entries(parsed)) {
          const idx = Number.parseInt(idxStr, 10);
          if (!Number.isNaN(idx)) {
            this.userResponses.set(idx, value);
          }
        }
      } catch {
        // Ignore corrupt replay metadata; the current response below may still apply.
      }
    }

    const userResponse = metadata.user_response;
    if (userResponse !== undefined) {
      const pauseIndex = Number.parseInt(metadata.pause_index ?? '0', 10);
      if (!Number.isNaN(pauseIndex)) {
        this.userResponses.set(pauseIndex, decodeUserResponse(userResponse));
      }
    }

    const signalName = metadata.signal_name;
    const signalPayload = metadata.signal_payload;
    if (signalName && signalPayload !== undefined) {
      const waitingStep = metadata.waiting_step || signalName;
      this.signalResponses.set(`${signalName}:${waitingStep}`, decodeSignalPayload(signalPayload));
    }
  }

  private stepEventsSnapshot(): Record<string, string | null> | undefined {
    if (this.userResponses.size === 0) {
      return undefined;
    }
    const stepEvents: Record<string, string | null> = {};
    for (const [idx, value] of this.userResponses.entries()) {
      stepEvents[String(idx)] = value;
    }
    return stepEvents;
  }

  get logger(): Logger {
    return {
      info: (message: string, meta?: Record<string, unknown>) => console.log(`[INFO] ${message}`, meta || ''),
      error: (message: string, meta?: Record<string, unknown>) => console.error(`[ERROR] ${message}`, meta || ''),
      warn: (message: string, meta?: Record<string, unknown>) => console.warn(`[WARN] ${message}`, meta || ''),
      debug: (message: string, meta?: Record<string, unknown>) => console.debug(`[DEBUG] ${message}`, meta || ''),
    };
  }

  async emit(event: unknown): Promise<void> {
    this.emittedEvents.push(normalizeWorkerlessEvent(event));
  }

  close(): void {
    // No resources to release for workerless in-memory execution.
  }

  private warnIfPotentialUnsafeStepChange(stepName: string, checkpointKey: string): void {
    if (this.initialStepCheckpointKeys.size === 0 || this.warnedStepCheckpointKeys.has(checkpointKey)) {
      return;
    }
    const unusedCheckpointKeys = Array.from(this.initialStepCheckpointKeys)
      .filter((key) => !this.visitedStepCheckpointKeys.has(key));
    if (unusedCheckpointKeys.length === 0) {
      return;
    }
    this.warnedStepCheckpointKeys.add(checkpointKey);
    this.logger.warn(
      'workerless step has no replay checkpoint while previous step checkpoints remain unused; changing ctx.step names can re-execute durable work',
      {
        step_name: stepName,
        checkpoint_key: checkpointKey,
        unused_checkpoint_count: unusedCheckpointKeys.length,
        unused_checkpoint_keys: unusedCheckpointKeys.slice(0, 5),
      },
    );
  }
}

function validateSleepDuration(durationMs: number): void {
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
    throw new Error('sleep durationMs must be a non-negative safe integer');
  }
}

function decodeUserResponse(userResponse: string): string | null {
  if (userResponse === '__skipped__' || userResponse === '__skip__') {
    return null;
  }
  if (userResponse.startsWith('__custom__:')) {
    return userResponse.slice('__custom__:'.length);
  }
  return userResponse;
}

function decodeSignalPayload(signalPayload: string): unknown {
  try {
    return JSON.parse(signalPayload);
  } catch {
    return signalPayload;
  }
}

function normalizeWorkerlessEvent(event: unknown): WorkerlessEmittedEvent {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('workerless emitted events must be objects');
  }
  const source = event as Record<string, unknown>;
  const eventType = stringField(source, 'event_type') ?? stringField(source, 'eventType');
  if (!eventType) {
    throw new Error('workerless emitted events must include event_type or eventType');
  }

  const data = Object.prototype.hasOwnProperty.call(source, 'data')
    ? jsonSafe(source.data)
    : snakeCaseObject(source);
  const metadata = stringMetadata(source.metadata);
  const normalized: WorkerlessEmittedEvent = {
    event_type: eventType,
    data,
    data_type: stringField(source, 'data_type') ?? stringField(source, 'dataType') ?? 'json',
  };
  if (metadata && Object.keys(metadata).length > 0) {
    normalized.metadata = metadata;
  }
  const timestampNs = numericField(source, 'timestamp_ns') ?? numericField(source, 'timestampNs');
  if (timestampNs !== undefined) {
    normalized.timestamp_ns = timestampNs;
  }
  const correlationId = stringField(source, 'correlation_id') ?? stringField(source, 'correlationId');
  if (correlationId) {
    normalized.correlation_id = correlationId;
  }
  const parentEventId = stringField(source, 'parent_event_id') ?? stringField(source, 'parentEventId');
  if (parentEventId) {
    normalized.parent_event_id = parentEventId;
  }
  const stepKey = stringField(source, 'step_key') ?? stringField(source, 'stepKey');
  if (stepKey) {
    normalized.step_key = stepKey;
  }
  return normalized;
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function numericField(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  if (typeof value === 'bigint') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function stringMetadata(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const metadata: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') {
      metadata[key] = entry;
    }
  }
  return metadata;
}

function snakeCaseObject(source: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    output[toSnakeCase(key)] = jsonSafe(value);
  }
  return output;
}

function toSnakeCase(key: string): string {
  return key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(jsonSafe);
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = jsonSafe(entry);
    }
    return output;
  }
  return value;
}
