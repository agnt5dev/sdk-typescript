/**
 * Event types for platform lifecycle tracking and streaming.
 *
 * Event hierarchy via correlation IDs:
 *   RunStarted
 *     → FunctionStarted / WorkflowStarted / AgentStarted / ToolStarted
 *       → (component-specific events)
 *     → FunctionCompleted / WorkflowCompleted / AgentCompleted / ToolCompleted
 *   RunCompleted | RunFailed
 *
 * Two routing paths (matching Rust core's JournalEventMessage classification):
 *   - Checkpoint events (lifecycle): persisted via WriteCheckpoint gRPC
 *   - SSE-only events (streaming): queued → flush task → EventStream
 */

import { randomUUID } from 'crypto';

// ─── Base event fields ───────────────────────────────────────────────

export interface BaseEvent {
  /** Human-readable event name */
  name: string;
  /** Correlation ID linking related events */
  correlationId: string;
  /** Parent correlation ID for event hierarchy */
  parentCorrelationId: string | null;
  /** Unique event ID */
  eventId: string;
  /** Timestamp in nanoseconds */
  timestampNs: bigint;
  /** Discriminator for the event type */
  eventType: string;
  /** Arbitrary metadata */
  metadata: Record<string, any>;
}

// ─── Agent lifecycle events ──────────────────────────────────────────

export interface AgentStarted extends BaseEvent {
  eventType: 'agent.started';
  agentName: string;
  agentModel: string;
  toolNames: string[];
  maxIterations: number;
}

export interface AgentCompleted extends BaseEvent {
  eventType: 'agent.completed';
  agentName: string;
  iterations: number;
  toolCallsCount: number;
  handoffTo: string | null;
  outputLength: number;
}

export interface AgentFailed extends BaseEvent {
  eventType: 'agent.failed';
  agentName: string;
  iterations: number;
  error: string;
}

// ─── Agent iteration events ──────────────────────────────────────────

export interface AgentIterationStarted extends BaseEvent {
  eventType: 'agent.iteration.started';
  iteration: number;
  maxIterations: number;
}

export interface AgentIterationCompleted extends BaseEvent {
  eventType: 'agent.iteration.completed';
  iteration: number;
  hasToolCalls: boolean;
  toolCallsCount: number;
}

// ─── Tool call events ────────────────────────────────────────────────

export interface ToolCallStarted extends BaseEvent {
  eventType: 'tool_call.started';
  toolName: string;
  toolCallId: string;
}

export interface ToolCallCompleted extends BaseEvent {
  eventType: 'tool_call.completed';
  toolName: string;
  toolCallId: string;
}

export interface ToolCallFailed extends BaseEvent {
  eventType: 'tool_call.failed';
  toolName: string;
  toolCallId: string;
  error: string;
}

// ─── Discriminated union ─────────────────────────────────────────────

export type AgentEvent =
  | AgentStarted
  | AgentCompleted
  | AgentFailed
  | AgentIterationStarted
  | AgentIterationCompleted
  | ToolCallStarted
  | ToolCallCompleted
  | ToolCallFailed;

// ─── Factory helpers ─────────────────────────────────────────────────

function baseFields(
  name: string,
  correlationId: string,
  parentCorrelationId: string | null,
  metadata: Record<string, any> = {},
): Omit<BaseEvent, 'eventType'> {
  return {
    name,
    correlationId,
    parentCorrelationId,
    eventId: randomUUID(),
    timestampNs: BigInt(Date.now()) * 1_000_000n,
    metadata,
  };
}

export function agentStarted(
  agentName: string,
  correlationId: string,
  opts: { agentModel: string; toolNames: string[]; maxIterations: number },
): AgentStarted {
  return {
    ...baseFields(`${agentName}.started`, correlationId, null),
    eventType: 'agent.started',
    agentName,
    agentModel: opts.agentModel,
    toolNames: opts.toolNames,
    maxIterations: opts.maxIterations,
  };
}

export function agentCompleted(
  agentName: string,
  correlationId: string,
  opts: { iterations: number; toolCallsCount: number; handoffTo: string | null; outputLength: number },
): AgentCompleted {
  return {
    ...baseFields(`${agentName}.completed`, correlationId, null),
    eventType: 'agent.completed',
    agentName,
    iterations: opts.iterations,
    toolCallsCount: opts.toolCallsCount,
    handoffTo: opts.handoffTo,
    outputLength: opts.outputLength,
  };
}

export function agentFailed(
  agentName: string,
  correlationId: string,
  opts: { iterations: number; error: string },
): AgentFailed {
  return {
    ...baseFields(`${agentName}.failed`, correlationId, null),
    eventType: 'agent.failed',
    agentName,
    iterations: opts.iterations,
    error: opts.error,
  };
}

export function iterationStarted(
  correlationId: string,
  parentCorrelationId: string,
  opts: { iteration: number; maxIterations: number },
): AgentIterationStarted {
  return {
    ...baseFields('iteration.started', correlationId, parentCorrelationId),
    eventType: 'agent.iteration.started',
    iteration: opts.iteration,
    maxIterations: opts.maxIterations,
  };
}

export function iterationCompleted(
  correlationId: string,
  parentCorrelationId: string,
  opts: { iteration: number; hasToolCalls: boolean; toolCallsCount: number },
): AgentIterationCompleted {
  return {
    ...baseFields('iteration.completed', correlationId, parentCorrelationId),
    eventType: 'agent.iteration.completed',
    iteration: opts.iteration,
    hasToolCalls: opts.hasToolCalls,
    toolCallsCount: opts.toolCallsCount,
  };
}

export function toolCallStarted(
  correlationId: string,
  parentCorrelationId: string,
  opts: { toolName: string; toolCallId: string },
): ToolCallStarted {
  return {
    ...baseFields(`tool.${opts.toolName}.started`, correlationId, parentCorrelationId),
    eventType: 'tool_call.started',
    toolName: opts.toolName,
    toolCallId: opts.toolCallId,
  };
}

export function toolCallCompleted(
  correlationId: string,
  parentCorrelationId: string,
  opts: { toolName: string; toolCallId: string },
): ToolCallCompleted {
  return {
    ...baseFields(`tool.${opts.toolName}.completed`, correlationId, parentCorrelationId),
    eventType: 'tool_call.completed',
    toolName: opts.toolName,
    toolCallId: opts.toolCallId,
  };
}

export function toolCallFailed(
  correlationId: string,
  parentCorrelationId: string,
  opts: { toolName: string; toolCallId: string; error: string },
): ToolCallFailed {
  return {
    ...baseFields(`tool.${opts.toolName}.failed`, correlationId, parentCorrelationId),
    eventType: 'tool_call.failed',
    toolName: opts.toolName,
    toolCallId: opts.toolCallId,
    error: opts.error,
  };
}

// ─── Event classification (mirrors Rust JournalEventMessage) ────────

/**
 * SSE-only events are ephemeral streaming/observability events.
 * They are NOT persisted and flow through the journal queue flush task.
 */
export function isSseOnlyEvent(eventType: string): boolean {
  return (
    eventType.startsWith('output.') ||
    eventType.startsWith('lm.stream.') ||
    eventType.startsWith('lm.message.') ||
    eventType.startsWith('lm.thinking.') ||
    eventType.startsWith('lm.tool_call.') ||
    eventType.startsWith('progress.') ||
    eventType.startsWith('log')
  );
}

/**
 * Checkpoint events are persisted lifecycle events that require sync acknowledgement.
 * They flow through the WriteCheckpoint gRPC RPC.
 */
export function isCheckpointEvent(eventType: string): boolean {
  return !isSseOnlyEvent(eventType);
}

// ─── Run lifecycle events ───────────────────────────────────────────

export interface RunStarted extends BaseEvent {
  eventType: 'run.started';
  inputData: any;
  attempt: number;
}

export interface RunCompleted extends BaseEvent {
  eventType: 'run.completed';
  outputData: any;
}

export interface RunFailed extends BaseEvent {
  eventType: 'run.failed';
  errorCode: string;
  errorMessage: string;
  attempt: number;
  maxAttempts: number;
}

// ─── Function lifecycle events ──────────────────────────────────────

export interface FunctionStarted extends BaseEvent {
  eventType: 'function.started';
  inputData: any;
  attempt: number;
}

export interface FunctionCompleted extends BaseEvent {
  eventType: 'function.completed';
  outputData: any;
  durationMs: number;
}

export interface FunctionFailed extends BaseEvent {
  eventType: 'function.failed';
  errorCode: string;
  errorMessage: string;
  durationMs: number;
}

// ─── Workflow lifecycle events ──────────────────────────────────────

export interface WorkflowStarted extends BaseEvent {
  eventType: 'workflow.started';
  inputData: any;
  attempt: number;
}

export interface WorkflowCompleted extends BaseEvent {
  eventType: 'workflow.completed';
  outputData: any;
  durationMs: number;
}

export interface WorkflowFailed extends BaseEvent {
  eventType: 'workflow.failed';
  errorCode: string;
  errorMessage: string;
  durationMs: number;
}

// ─── Tool lifecycle events (platform dispatch) ──────────────────────

export interface ToolStarted extends BaseEvent {
  eventType: 'tool.started';
  inputData: any;
  attempt: number;
}

export interface ToolCompleted extends BaseEvent {
  eventType: 'tool.completed';
  outputData: any;
  durationMs: number;
}

export interface ToolFailed extends BaseEvent {
  eventType: 'tool.failed';
  errorCode: string;
  errorMessage: string;
  durationMs: number;
}

// ─── Streaming events (SSE-only) ───────────────────────────────────

export interface OutputStart extends BaseEvent {
  eventType: 'output.start';
}

export interface OutputDelta extends BaseEvent {
  eventType: 'output.delta';
  content: string;
  contentIndex: number;
}

export interface OutputStop extends BaseEvent {
  eventType: 'output.stop';
}

// ─── Full discriminated union ───────────────────────────────────────

export type LifecycleEvent =
  | RunStarted | RunCompleted | RunFailed
  | FunctionStarted | FunctionCompleted | FunctionFailed
  | WorkflowStarted | WorkflowCompleted | WorkflowFailed
  | ToolStarted | ToolCompleted | ToolFailed
  | OutputStart | OutputDelta | OutputStop;

export type PlatformEvent = AgentEvent | LifecycleEvent;

// ─── Lifecycle factory helpers ──────────────────────────────────────

export function generateCid(): string {
  return randomUUID().slice(0, 8);
}

export function runStarted(
  correlationId: string,
  parentCorrelationId: string | null,
  opts: { inputData: any; attempt: number },
): RunStarted {
  return {
    ...baseFields('run.started', correlationId, parentCorrelationId),
    eventType: 'run.started',
    inputData: opts.inputData,
    attempt: opts.attempt,
  };
}

export function runCompleted(
  correlationId: string,
  parentCorrelationId: string | null,
  opts: { outputData: any },
): RunCompleted {
  return {
    ...baseFields('run.completed', correlationId, parentCorrelationId),
    eventType: 'run.completed',
    outputData: opts.outputData,
  };
}

export function runFailed(
  correlationId: string,
  parentCorrelationId: string | null,
  opts: { errorCode: string; errorMessage: string; attempt: number; maxAttempts: number },
): RunFailed {
  return {
    ...baseFields('run.failed', correlationId, parentCorrelationId, {
      attempt: String(opts.attempt),
      max_attempts: String(opts.maxAttempts),
    }),
    eventType: 'run.failed',
    errorCode: opts.errorCode,
    errorMessage: opts.errorMessage,
    attempt: opts.attempt,
    maxAttempts: opts.maxAttempts,
  };
}

export function functionStarted(
  correlationId: string,
  parentCorrelationId: string,
  opts: { inputData: any; attempt: number },
): FunctionStarted {
  return {
    ...baseFields('function.started', correlationId, parentCorrelationId),
    eventType: 'function.started',
    inputData: opts.inputData,
    attempt: opts.attempt,
  };
}

export function functionCompleted(
  correlationId: string,
  parentCorrelationId: string,
  opts: { outputData: any; durationMs: number },
): FunctionCompleted {
  return {
    ...baseFields('function.completed', correlationId, parentCorrelationId),
    eventType: 'function.completed',
    outputData: opts.outputData,
    durationMs: opts.durationMs,
  };
}

export function functionFailed(
  correlationId: string,
  parentCorrelationId: string,
  opts: { errorCode: string; errorMessage: string; durationMs: number },
): FunctionFailed {
  return {
    ...baseFields('function.failed', correlationId, parentCorrelationId),
    eventType: 'function.failed',
    errorCode: opts.errorCode,
    errorMessage: opts.errorMessage,
    durationMs: opts.durationMs,
  };
}

export function workflowStarted(
  correlationId: string,
  parentCorrelationId: string,
  opts: { inputData: any; attempt: number },
): WorkflowStarted {
  return {
    ...baseFields('workflow.started', correlationId, parentCorrelationId),
    eventType: 'workflow.started',
    inputData: opts.inputData,
    attempt: opts.attempt,
  };
}

export function workflowCompleted(
  correlationId: string,
  parentCorrelationId: string,
  opts: { outputData: any; durationMs: number },
): WorkflowCompleted {
  return {
    ...baseFields('workflow.completed', correlationId, parentCorrelationId),
    eventType: 'workflow.completed',
    outputData: opts.outputData,
    durationMs: opts.durationMs,
  };
}

export function workflowFailed(
  correlationId: string,
  parentCorrelationId: string,
  opts: { errorCode: string; errorMessage: string; durationMs: number },
): WorkflowFailed {
  return {
    ...baseFields('workflow.failed', correlationId, parentCorrelationId),
    eventType: 'workflow.failed',
    errorCode: opts.errorCode,
    errorMessage: opts.errorMessage,
    durationMs: opts.durationMs,
  };
}

export function toolStarted(
  correlationId: string,
  parentCorrelationId: string,
  opts: { inputData: any; attempt: number },
): ToolStarted {
  return {
    ...baseFields('tool.started', correlationId, parentCorrelationId),
    eventType: 'tool.started',
    inputData: opts.inputData,
    attempt: opts.attempt,
  };
}

export function toolCompleted(
  correlationId: string,
  parentCorrelationId: string,
  opts: { outputData: any; durationMs: number },
): ToolCompleted {
  return {
    ...baseFields('tool.completed', correlationId, parentCorrelationId),
    eventType: 'tool.completed',
    outputData: opts.outputData,
    durationMs: opts.durationMs,
  };
}

export function toolFailed(
  correlationId: string,
  parentCorrelationId: string,
  opts: { errorCode: string; errorMessage: string; durationMs: number },
): ToolFailed {
  return {
    ...baseFields('tool.failed', correlationId, parentCorrelationId),
    eventType: 'tool.failed',
    errorCode: opts.errorCode,
    errorMessage: opts.errorMessage,
    durationMs: opts.durationMs,
  };
}

/**
 * Convert a BaseEvent to a plain data payload for emission.
 * Strips internal fields (correlationId, parentCorrelationId, eventId, etc.)
 * and returns just the domain-specific data fields.
 */
export function toEventPayload(event: BaseEvent): Record<string, any> {
  const { name, correlationId, parentCorrelationId, eventId, timestampNs, eventType, metadata, ...data } = event;
  return data;
}
