/**
 * Agent event types for streaming execution.
 *
 * Events form a hierarchy via correlation IDs:
 *   AgentStarted
 *     → AgentIterationStarted
 *       → ToolCallStarted / ToolCallCompleted / ToolCallFailed
 *     → AgentIterationCompleted
 *   AgentCompleted | AgentFailed
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
