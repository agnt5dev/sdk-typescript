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
export { Client, EntityProxy } from './client.js';
export type { ClientOptions, RunOptions, RunResponse } from './client.js';

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
export { Tool, ToolRegistry, tool } from './tool.js';

// Entity exports
export {
  entity,
  EntityType,
  EntityInstance,
  _clearEntityState,
  _getEntityState,
  _getAllEntityKeys
} from './entity.js';

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
} from './workflow-utils.js';

// Agent exports
export { Agent, MessageRole, Message } from './agent.js';
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
} from './lm.js';

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
