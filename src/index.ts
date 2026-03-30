/**
 * AGNT5 TypeScript SDK
 *
 * Durable AI workflows and agents for TypeScript.
 *
 * @packageDocumentation
 */

// Core exports
export { fn, FunctionBuilder } from './function.js';
export { Worker, getRuntime, checkPlatformConnectivity } from './worker.js';
export type { PlatformWorkerOptions } from './worker.js';
export { ContextImpl } from './context.js';
export { PlatformContext } from './platform-context.js';

// Client exports
export { Client, EntityProxy, RunResponse, WorkflowProxy, SessionProxy } from './client.js';
export type { ClientOptions, RunOptions, RunStatus, RunErrorDetail, SubmitResponse, ReceivedEvent, EventRecord, EventsResponse } from './client.js';

// Batch exports
export { BatchResult, BatchStatusResult } from './batch.js';
export type { BatchConfig, BatchItemInput, BatchItemResult, BatchItemError, BatchStats, BatchStatus, CancelBatchResult } from './batch.js';

// Error exports
export {
  AGNT5Error,
  ConfigurationError,
  ExecutionError,
  RetryError,
  StateError,
  CheckpointError,
  RunError,
  WaitingForUserInputError,
  ConnectionError,
  TimeoutError,
  ValidationError,
  AuthorizationError,
  isAGNT5Error,
  isWaitingForUserInput,
  getErrorMessage,
  createErrorFromResponse,
} from './errors.js';
export type { HITLInputType, HITLOption } from './errors.js';

// Retry utilities exports
export {
  parseRetryPolicy,
  parseBackoffPolicy,
  calculateBackoffDelay,
  executeWithRetry,
  createRetryWrapper,
  executeWithRetryAndTimeout,
  DEFAULT_RETRY_POLICY,
  DEFAULT_BACKOFF_POLICY,
} from './retry-utils.js';
export type { RetryPredicate, ExecuteWithRetryOptions } from './retry-utils.js';

// Schema utilities exports
export {
  detectFormatType,
  isZodSchema,
  isTypeBoxSchema,
  isJsonSchema,
  zodToJsonSchema,
  typeBoxToJsonSchema,
  typeToSchema,
  createObjectSchema,
  createArraySchema,
  createEnumSchema,
  createUnionSchema,
  makeOptional,
  mergeSchemas,
  validateSchema,
  extractFunctionDescription,
} from './schema-utils.js';
export type { SchemaFormat, SchemaConversionOptions } from './schema-utils.js';

// Tool exports
export { Tool, ToolRegistry, tool, AskUserTool, RequestApprovalTool } from './tool.js';


// Workflow exports
export { workflow, WorkflowRegistry } from './workflow.js';
export type { WorkflowConfig, WorkflowOptions } from './workflow.js';
export {
  parallel,
  gather,
  executeChildWorkflow,
  parallelWorkflows,
  gatherWorkflows,
  fanOut,
  batchExecute,
  race,
  withTimeout,
  saga,
  retryWorkflow,
  sleep,
} from './workflow-utils.js';

// Chat SDK exports
export { ChatBot } from './chat.js';
export type { SlackConfig, DiscordConfig, TeamsConfig, TelegramConfig, PlatformConfig, ChatEvent, ChatMessage, ChatUser, ChatEventHandler } from './chat.js';

// Agent exports
export { Agent, AgentRegistry, MessageRole, Message, Handoff, handoff } from './agent.js';
export type {
  Message as IMessage,
  ToolCall,
  TokenUsage,
  GenerationConfig,
  GenerateRequest,
  GenerateResponse,
  LanguageModel,
  AgentResult,
  AgentOptions
} from './agent.js';

// Event exports
export type {
  AgentEvent,
  BaseEvent,
  AgentStarted,
  AgentCompleted,
  AgentFailed,
  AgentIterationStarted,
  AgentIterationCompleted,
  ToolCallStarted,
  ToolCallCompleted,
  ToolCallFailed,
  // Lifecycle events
  RunStarted,
  RunCompleted,
  RunFailed,
  FunctionStarted,
  FunctionCompleted,
  FunctionFailed,
  WorkflowStarted,
  WorkflowCompleted,
  WorkflowFailed,
  ToolStarted,
  ToolCompleted,
  ToolFailed,
  OutputStart,
  OutputDelta,
  OutputStop,
  LifecycleEvent,
  PlatformEvent,
} from './events.js';
export {
  agentStarted,
  agentCompleted,
  agentFailed,
  iterationStarted,
  iterationCompleted,
  toolCallStarted,
  toolCallCompleted,
  toolCallFailed,
  // Lifecycle factories
  generateCid,
  runStarted,
  runCompleted,
  runFailed,
  functionStarted,
  functionCompleted,
  functionFailed,
  workflowStarted,
  workflowCompleted,
  workflowFailed,
  toolStarted,
  toolCompleted,
  toolFailed,
  // Classification
  isCheckpointEvent,
  isSseOnlyEvent,
  toEventPayload,
} from './events.js';

// EventEmitter export
export { EventEmitter } from './event-emitter.js';

// Language Model exports
export { LM, systemMessage, userMessage, assistantMessage, createTool, parseToolArguments, jsonSchemaFormat } from './lm.js';
export type {
  Message as LMMessage,
  MessageRole as LMMessageRole,
  ToolDefinition as LMToolDefinition,
  ToolCall as LMToolCall,
  TokenUsage as LMTokenUsage,
  GenerateResponse as LMGenerateResponse,
  StreamChunk,
  ReasoningEffort,
  Modality,
  BuiltInTool,
  GenerationConfig as LMGenerationConfig,
  ResponseFormatOption,
  ToolChoiceOption,
  GenerateRequest as LMGenerateRequest,
  OpenAIConfig,
  AnthropicConfig,
  AzureOpenAIConfig,
  BedrockConfig,
  GroqConfig,
  OpenRouterConfig,
  DeepSeekConfig,
  GoogleConfig,
  MistralConfig,
  OllamaConfig,
  XaiConfig,
  HuggingFaceConfig,
  OpenAiChatConfig,
} from './lm.js';

// Context propagation exports
export { runWithContext, getCurrentContext, requireContext } from './async-context.js';
export type { PropagatedContext } from './async-context.js';

// State management exports
export {
  StateManager,
  SessionContext,
  UserContext,
  ScopedState,
  MemoryStateAdapter,
} from './state.js';
export type { StateAdapter } from './state.js';

// MCP exports
export { MCPClient, MCPError } from './mcp.js';
export type {
  McpTool,
  McpToolWithServer,
  ToolContent,
  CallToolResult,
  StdioConfig,
  SseConfig,
  TransportType,
  ServerConfig,
  ServerCapabilities,
  ServerInfo,
} from './mcp.js';

// Tracing exports
export { Span, withSpan, spanContext, span, getCurrentSpanInfo } from './tracing.js';
export type { SpanInfo } from './tracing.js';

// Scorer exports
export {
  ScorerResult,
  ScorerRegistry,
  scorer,
  isScorer,
  getScorerConfig,
  runScorer,
  exactMatch,
  contains,
  jsonValid,
  regexMatch,
  levenshtein,
  getRequestConfig,
  getTraceEvents,
  getTotalTokens,
} from './scorer.js';
export type {
  ScorerRequest,
  ScorerResultSummary,
  ScorerContext,
  ScorerHandler,
  ScorerConfig,
  TraceEvent,
} from './scorer.js';

// Evaluation exports
export {
  EvalContext,
  EvalResponse,
  BatchEvalItemResult,
  BatchEvalResult,
  LLMJudge,
  TraceAssertion,
  traceScorer,
  normalizeBatchEvalItems,
  normalizeScorerSpecs,
} from './eval.js';
export type {
  AssertionResult,
  TraceScorerResult,
  BatchEvalItem,
  BatchEvalStats,
  LLMJudgeConfig,
} from './eval.js';

// Memory exports
export {
  MemoryScope,
  ConversationMemory,
  SemanticMemory,
  InMemorySemanticAdapter,
  GraphMemory,
} from './memory.js';
export type {
  MemoryScopeType,
  MemoryMessage,
  MemoryMetadata,
  MemoryResult,
  SemanticMemoryAdapter,
  GraphNode,
  GraphRelationship,
  GraphTraversalResult,
} from './memory.js';

// Logging exports
export { ContextLogger, getLogger, setLogLevel, getLogLevel } from './logging.js';
export type { LogLevel } from './logging.js';

// Platform adapter exports
export {
  StubJobQueueAdapter,
  StubPlatformStateAdapter,
  StubPlatformSpanAdapter,
  NapiPlatformSpanAdapter,
  startJobQueuePolling,
} from './platform-adapters.js';
export type {
  JobAssignment,
  JobCompletionResult,
  JobQueueAdapter,
  SpanAttributes,
  PlatformSpanAdapter,
  PlatformSpanHandle,
  JobQueueConfig,
} from './platform-adapters.js';

// Type exports
export type {
  Context,
  Logger,
  FunctionHandler,
  FunctionOptions,
  RetryPolicy,
  BackoffPolicy,
  WorkerOptions,
  JSONSchema,
  ToolHandler,
  ToolSchema,
  ToolOptions,
  EntityMethod,
  WorkflowHandler
} from './types.js';

/**
 * SDK version
 */
export const VERSION = '0.1.0';

/**
 * Get binding type being used
 * @returns 'napi' for native bindings, 'wasm' for WebAssembly
 */
export function getBindingType(): 'napi' | 'wasm' | 'unknown' {
  const runtime = getRuntime();
  if (runtime === 'edge') return 'wasm';
  if (runtime === 'node' || runtime === 'bun' || runtime === 'deno') return 'napi';
  return 'unknown';
}

// Re-export getRuntime for convenience
import { getRuntime } from './worker.js';
