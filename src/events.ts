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

import { randomUUID } from 'node:crypto';

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
  /**
   * Component classification for the trace/steps tree (run, function, workflow,
   * tool, agent, lm, step). Mirrors the Python SDK's `component_type` field — the
   * Studio trace projection uses it to label and group steps. Optional fields
   * that are left undefined are dropped during serialization.
   */
  componentType?: string;
  /** Operation type for sub-component events (iteration, tool_call). */
  operation?: string;
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
  inputData?: any;
}

export interface ToolCallCompleted extends BaseEvent {
  eventType: 'tool_call.completed';
  toolName: string;
  toolCallId: string;
  outputData?: any;
}

export interface ToolCallFailed extends BaseEvent {
  eventType: 'tool_call.failed';
  toolName: string;
  toolCallId: string;
  error: string;
}

// ─── Skill events ────────────────────────────────────────────────────

export interface SkillLoaded extends BaseEvent {
  eventType: 'skill.loaded';
  skillName: string;
  instructionsLength: number;
  resourcesMaterialized: number;
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
  | ToolCallFailed
  | SkillLoaded;

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
    ...baseFields(agentName, correlationId, null),
    eventType: 'agent.started',
    componentType: 'agent',
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
    ...baseFields(agentName, correlationId, null),
    eventType: 'agent.completed',
    componentType: 'agent',
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
    ...baseFields(agentName, correlationId, null),
    eventType: 'agent.failed',
    componentType: 'agent',
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
    ...baseFields('iteration', correlationId, parentCorrelationId),
    eventType: 'agent.iteration.started',
    componentType: 'agent',
    operation: 'iteration',
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
    ...baseFields('iteration', correlationId, parentCorrelationId),
    eventType: 'agent.iteration.completed',
    componentType: 'agent',
    operation: 'iteration',
    iteration: opts.iteration,
    hasToolCalls: opts.hasToolCalls,
    toolCallsCount: opts.toolCallsCount,
  };
}

export function toolCallStarted(
  correlationId: string,
  parentCorrelationId: string,
  opts: { toolName: string; toolCallId: string; inputData?: any },
): ToolCallStarted {
  return {
    ...baseFields(opts.toolName, correlationId, parentCorrelationId),
    eventType: 'tool_call.started',
    componentType: 'agent',
    operation: 'tool_call',
    toolName: opts.toolName,
    toolCallId: opts.toolCallId,
    inputData: opts.inputData,
  };
}

export function toolCallCompleted(
  correlationId: string,
  parentCorrelationId: string,
  opts: { toolName: string; toolCallId: string; outputData?: any },
): ToolCallCompleted {
  return {
    ...baseFields(opts.toolName, correlationId, parentCorrelationId),
    eventType: 'tool_call.completed',
    componentType: 'agent',
    operation: 'tool_call',
    toolName: opts.toolName,
    toolCallId: opts.toolCallId,
    outputData: opts.outputData,
  };
}

export function toolCallFailed(
  correlationId: string,
  parentCorrelationId: string,
  opts: { toolName: string; toolCallId: string; error: string },
): ToolCallFailed {
  return {
    ...baseFields(opts.toolName, correlationId, parentCorrelationId),
    eventType: 'tool_call.failed',
    componentType: 'agent',
    operation: 'tool_call',
    toolName: opts.toolName,
    toolCallId: opts.toolCallId,
    error: opts.error,
  };
}

export function skillLoaded(
  correlationId: string,
  parentCorrelationId: string | null,
  opts: { skillName: string; instructionsLength: number; resourcesMaterialized: number },
): SkillLoaded {
  return {
    ...baseFields('load_skill', correlationId, parentCorrelationId),
    eventType: 'skill.loaded',
    componentType: 'tool',
    skillName: opts.skillName,
    instructionsLength: opts.instructionsLength,
    resourcesMaterialized: opts.resourcesMaterialized,
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
    eventType.startsWith('lm.content_block.') ||
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

// ─── Log events (SSE-only, populate the Studio Logs panel) ──────────

/**
 * Application/SDK log line surfaced in the Studio Logs panel.
 *
 * Mirrors the Python SDK's OpenTelemetryHandler, which emits a `log.{level}`
 * journal event (in addition to OTLP export) for every record produced inside a
 * run. Without this, the TypeScript Logs panel shows "No logs generated" even
 * for fully-executed runs (AGNT5-569). `log.*` is classified SSE-only, so it
 * flows through the journal queue like Python's log events.
 */
export interface LogEvent extends BaseEvent {
  level: string;
  message: string;
  target: string;
  attributes?: Record<string, any>;
}

export function logEvent(
  level: string,
  name: string,
  message: string,
  correlationId: string,
  parentCorrelationId: string | null,
  attributes?: Record<string, any>,
): LogEvent {
  const upper = level.toUpperCase();
  return {
    ...baseFields(name, correlationId, parentCorrelationId, {}),
    eventType: `log.${upper.toLowerCase()}`,
    level: upper,
    message,
    target: name,
    attributes: attributes && Object.keys(attributes).length > 0 ? attributes : undefined,
  };
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

export interface WorkflowPaused extends BaseEvent {
  eventType: 'workflow.paused';
  reason: string;
  pauseData: Record<string, any>;
}

// ─── Workflow step lifecycle events ─────────────────────────────────

export interface WorkflowStepStarted extends BaseEvent {
  eventType: 'workflow.step.started';
  inputData: { handler_name: string; input: any; step_name: string };
  attempt: number;
}

export interface WorkflowStepCompleted extends BaseEvent {
  eventType: 'workflow.step.completed';
  outputData: { handler_name: string; result: any; step_name: string };
  durationMs: number;
}

export interface WorkflowStepFailed extends BaseEvent {
  eventType: 'workflow.step.failed';
  errorCode: string;
  errorMessage: string;
  durationMs: number;
}

// ─── LM lifecycle events ────────────────────────────────────────────

export interface LMStarted extends BaseEvent {
  eventType: 'lm.started';
  inputData: {
    messages: any[];
    system_prompt?: string;
    tools_count: number;
    temperature?: number;
    max_tokens?: number | null;
  };
  attempt: number;
}

export interface LMCompleted extends BaseEvent {
  eventType: 'lm.completed';
  outputData: { output: string; tool_calls?: any };
  durationMs: number;
}

export interface LMFailed extends BaseEvent {
  eventType: 'lm.failed';
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

export function outputDelta(
  correlationId: string,
  parentCorrelationId: string | null,
  content: string,
  contentIndex = 0,
): OutputDelta {
  return {
    ...baseFields('output', correlationId, parentCorrelationId),
    eventType: 'output.delta',
    content,
    contentIndex,
  };
}

// ─── Full discriminated union ───────────────────────────────────────

export type LifecycleEvent =
  | RunStarted | RunCompleted | RunFailed
  | FunctionStarted | FunctionCompleted | FunctionFailed
  | WorkflowStarted | WorkflowCompleted | WorkflowFailed | WorkflowPaused
  | WorkflowStepStarted | WorkflowStepCompleted | WorkflowStepFailed
  | LMStarted | LMCompleted | LMFailed
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
  opts: { inputData: any; attempt: number; componentName?: string },
): RunStarted {
  return {
    ...baseFields(opts.componentName ?? 'run', correlationId, parentCorrelationId),
    eventType: 'run.started',
    componentType: 'run',
    inputData: opts.inputData,
    attempt: opts.attempt,
  };
}

export function runCompleted(
  correlationId: string,
  parentCorrelationId: string | null,
  opts: { outputData: any; componentName?: string },
): RunCompleted {
  return {
    ...baseFields(opts.componentName ?? 'run', correlationId, parentCorrelationId),
    eventType: 'run.completed',
    componentType: 'run',
    outputData: opts.outputData,
  };
}

export function runFailed(
  correlationId: string,
  parentCorrelationId: string | null,
  opts: { errorCode: string; errorMessage: string; attempt: number; maxAttempts: number; componentName?: string },
): RunFailed {
  return {
    ...baseFields(opts.componentName ?? 'run', correlationId, parentCorrelationId, {
      attempt: String(opts.attempt),
      max_attempts: String(opts.maxAttempts),
    }),
    eventType: 'run.failed',
    componentType: 'run',
    errorCode: opts.errorCode,
    errorMessage: opts.errorMessage,
    attempt: opts.attempt,
    maxAttempts: opts.maxAttempts,
  };
}

export function functionStarted(
  correlationId: string,
  parentCorrelationId: string,
  opts: { inputData: any; attempt: number; componentName?: string },
): FunctionStarted {
  return {
    ...baseFields(opts.componentName ?? 'function', correlationId, parentCorrelationId),
    eventType: 'function.started',
    componentType: 'function',
    inputData: opts.inputData,
    attempt: opts.attempt,
  };
}

export function functionCompleted(
  correlationId: string,
  parentCorrelationId: string,
  opts: { outputData: any; durationMs: number; componentName?: string },
): FunctionCompleted {
  return {
    ...baseFields(opts.componentName ?? 'function', correlationId, parentCorrelationId),
    eventType: 'function.completed',
    componentType: 'function',
    outputData: opts.outputData,
    durationMs: opts.durationMs,
  };
}

export function functionFailed(
  correlationId: string,
  parentCorrelationId: string,
  opts: { errorCode: string; errorMessage: string; durationMs: number; componentName?: string },
): FunctionFailed {
  return {
    ...baseFields(opts.componentName ?? 'function', correlationId, parentCorrelationId),
    eventType: 'function.failed',
    componentType: 'function',
    errorCode: opts.errorCode,
    errorMessage: opts.errorMessage,
    durationMs: opts.durationMs,
  };
}

export function workflowStarted(
  correlationId: string,
  parentCorrelationId: string,
  opts: { inputData: any; attempt: number; componentName?: string },
): WorkflowStarted {
  return {
    ...baseFields(opts.componentName ?? 'workflow', correlationId, parentCorrelationId),
    eventType: 'workflow.started',
    componentType: 'workflow',
    inputData: opts.inputData,
    attempt: opts.attempt,
  };
}

export function workflowCompleted(
  correlationId: string,
  parentCorrelationId: string,
  opts: { outputData: any; durationMs: number; componentName?: string },
): WorkflowCompleted {
  return {
    ...baseFields(opts.componentName ?? 'workflow', correlationId, parentCorrelationId),
    eventType: 'workflow.completed',
    componentType: 'workflow',
    outputData: opts.outputData,
    durationMs: opts.durationMs,
  };
}

export function workflowFailed(
  correlationId: string,
  parentCorrelationId: string,
  opts: { errorCode: string; errorMessage: string; durationMs: number; componentName?: string },
): WorkflowFailed {
  return {
    ...baseFields(opts.componentName ?? 'workflow', correlationId, parentCorrelationId),
    eventType: 'workflow.failed',
    componentType: 'workflow',
    errorCode: opts.errorCode,
    errorMessage: opts.errorMessage,
    durationMs: opts.durationMs,
  };
}

/**
 * Workflow paused event — emitted when a workflow pauses for user input.
 *
 * The runtime treats `workflow.paused` as terminal for the synchronous
 * workflow endpoint and transitions the run's status to `paused`.
 *
 * Metadata carries fields the UI / resume endpoint need (question, options,
 * pause_index, step_name, etc.).
 */
export function workflowPaused(
  correlationId: string,
  parentCorrelationId: string,
  opts: {
    reason: string;
    pauseData: Record<string, any>;
    metadata?: Record<string, string>;
  },
): WorkflowPaused {
  return {
    ...baseFields('workflow.paused', correlationId, parentCorrelationId, opts.metadata || {}),
    eventType: 'workflow.paused',
    componentType: 'workflow',
    reason: opts.reason,
    pauseData: opts.pauseData,
  };
}

export function toolStarted(
  correlationId: string,
  parentCorrelationId: string,
  opts: { inputData: any; attempt: number; componentName?: string },
): ToolStarted {
  return {
    ...baseFields(opts.componentName ?? 'tool', correlationId, parentCorrelationId),
    eventType: 'tool.started',
    componentType: 'tool',
    inputData: opts.inputData,
    attempt: opts.attempt,
  };
}

export function toolCompleted(
  correlationId: string,
  parentCorrelationId: string,
  opts: { outputData: any; durationMs: number; componentName?: string },
): ToolCompleted {
  return {
    ...baseFields(opts.componentName ?? 'tool', correlationId, parentCorrelationId),
    eventType: 'tool.completed',
    componentType: 'tool',
    outputData: opts.outputData,
    durationMs: opts.durationMs,
  };
}

export function toolFailed(
  correlationId: string,
  parentCorrelationId: string,
  opts: { errorCode: string; errorMessage: string; durationMs: number; componentName?: string },
): ToolFailed {
  return {
    ...baseFields(opts.componentName ?? 'tool', correlationId, parentCorrelationId),
    eventType: 'tool.failed',
    componentType: 'tool',
    errorCode: opts.errorCode,
    errorMessage: opts.errorMessage,
    durationMs: opts.durationMs,
  };
}

export function workflowStepStarted(
  correlationId: string,
  parentCorrelationId: string,
  opts: { handlerName: string; stepName: string; input: any; attempt: number },
): WorkflowStepStarted {
  return {
    ...baseFields(opts.stepName, correlationId, parentCorrelationId, { name: opts.stepName }),
    eventType: 'workflow.step.started',
    componentType: 'step',
    inputData: {
      handler_name: opts.handlerName,
      input: opts.input,
      step_name: opts.stepName,
    },
    attempt: opts.attempt,
  };
}

export function workflowStepCompleted(
  correlationId: string,
  parentCorrelationId: string,
  opts: { handlerName: string; stepName: string; result: any; durationMs: number },
): WorkflowStepCompleted {
  return {
    ...baseFields(opts.stepName, correlationId, parentCorrelationId, { name: opts.stepName }),
    eventType: 'workflow.step.completed',
    componentType: 'step',
    outputData: {
      handler_name: opts.handlerName,
      result: opts.result,
      step_name: opts.stepName,
    },
    durationMs: opts.durationMs,
  };
}

export function workflowStepFailed(
  correlationId: string,
  parentCorrelationId: string,
  opts: { stepName: string; errorCode: string; errorMessage: string; durationMs: number },
): WorkflowStepFailed {
  return {
    ...baseFields(opts.stepName, correlationId, parentCorrelationId, { name: opts.stepName }),
    eventType: 'workflow.step.failed',
    componentType: 'step',
    errorCode: opts.errorCode,
    errorMessage: opts.errorMessage,
    durationMs: opts.durationMs,
  };
}

export function lmStarted(
  correlationId: string,
  parentCorrelationId: string,
  opts: {
    model: string;
    provider: string;
    messages: any[];
    systemPrompt?: string;
    toolsCount: number;
    temperature?: number;
    maxTokens?: number | null;
    attempt?: number;
  },
): LMStarted {
  return {
    ...baseFields(opts.model, correlationId, parentCorrelationId, {
      name: opts.model,
      model: opts.model,
      provider: opts.provider,
    }),
    eventType: 'lm.started',
    componentType: 'lm',
    inputData: {
      messages: opts.messages,
      system_prompt: opts.systemPrompt,
      tools_count: opts.toolsCount,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens ?? null,
    },
    attempt: opts.attempt ?? 1,
  };
}

export function lmCompleted(
  correlationId: string,
  parentCorrelationId: string,
  opts: {
    model: string;
    provider: string;
    output: string;
    toolCalls?: any;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    durationMs: number;
  },
): LMCompleted {
  return {
    ...baseFields(opts.model, correlationId, parentCorrelationId, {
      name: opts.model,
      model: opts.model,
      provider: opts.provider,
      input_tokens: String(opts.inputTokens),
      output_tokens: String(opts.outputTokens),
      total_tokens: String(opts.totalTokens),
      duration_ms: String(opts.durationMs),
    }),
    eventType: 'lm.completed',
    componentType: 'lm',
    outputData: {
      output: opts.output,
      tool_calls: opts.toolCalls ?? null,
    },
    durationMs: opts.durationMs,
  };
}

export function lmFailed(
  correlationId: string,
  parentCorrelationId: string,
  opts: {
    model: string;
    provider: string;
    errorCode: string;
    errorMessage: string;
    durationMs: number;
  },
): LMFailed {
  return {
    ...baseFields(opts.model, correlationId, parentCorrelationId, {
      name: opts.model,
      model: opts.model,
      provider: opts.provider,
    }),
    eventType: 'lm.failed',
    componentType: 'lm',
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
