/**
 * Language Model (LLM) integration for AGNT5 TypeScript SDK
 *
 * Provides unified interface to multiple LLM providers:
 * - OpenAI (GPT-4, o1, o3)
 * - Anthropic (Claude)
 * - Azure OpenAI
 * - AWS Bedrock
 * - Groq
 * - OpenRouter
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { JSONSchema } from './types.js';

// Native bindings (loaded dynamically)
let nativeBindings: any = null;

/**
 * Load native bindings
 * @internal
 */
function loadNativeBindings() {
  if (nativeBindings) return nativeBindings;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const require = createRequire(import.meta.url);

  // Try multiple paths to find the native module
  const possiblePaths = [
    join(__dirname, '../../native/agnt5-sdk-native.darwin-arm64.node'),
    join(__dirname, '../native/agnt5-sdk-native.darwin-arm64.node'),
    join(__dirname, '../../native/agnt5-sdk-native.linux-x64-gnu.node'),
    join(__dirname, '../native/agnt5-sdk-native.linux-x64-gnu.node'),
    join(__dirname, '../../native/agnt5-sdk-native.linux-x64.node'),
    join(__dirname, '../native/agnt5-sdk-native.linux-x64.node'),
  ];

  for (const nativePath of possiblePaths) {
    try {
      nativeBindings = require(nativePath);
      return nativeBindings;
    } catch (e) {
      continue;
    }
  }

  throw new Error('Could not find native LM bindings');
}

// ============================================================================
// Types
// ============================================================================

export type MessageRole = 'system' | 'user' | 'assistant';

export interface Message {
  role: MessageRole;
  content: string;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: string; // JSON string
  strict?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface GenerateResponse {
  id: string;
  model: string;
  created?: number;
  text: string;
  usage?: TokenUsage;
  finishReason?: string;
  toolCalls?: ToolCall[];
  raw?: string; // JSON string
}

export interface StreamChunk {
  chunkType: 'delta' | 'completed';
  content?: string;
  response?: GenerateResponse;
}

export type ReasoningEffort = 'minimal' | 'medium' | 'high';
export type Modality = 'text' | 'audio' | 'image';
export type BuiltInTool = 'web_search' | 'code_interpreter' | 'file_search';

export interface GenerationConfig {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  responseFormat?: ResponseFormatOption;
  reasoningEffort?: ReasoningEffort;
  modalities?: Modality[];
  builtInTools?: BuiltInTool[];
}

export interface ResponseFormatOption {
  formatType: 'text' | 'json' | 'json_schema';
  schemaName?: string;
  schema?: string; // JSON string
  strict?: boolean;
}

export interface ToolChoiceOption {
  choiceType: 'auto' | 'none' | 'tool';
  toolName?: string;
}

export interface GenerateRequest {
  model: string;
  systemPrompt?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoiceOption;
  userId?: string;
  config?: GenerationConfig;
}

// Provider configs
export interface OpenAIConfig {
  apiKey?: string;
  organizationId?: string;
  baseUrl?: string;
}

export interface AnthropicConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface AzureOpenAIConfig {
  apiKey?: string;
  endpoint: string;
  apiVersion?: string;
}

export interface BedrockConfig {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

export interface GroqConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface OpenRouterConfig {
  apiKey?: string;
  baseUrl?: string;
}

// ============================================================================
// LM Class (TypeScript wrapper)
// ============================================================================

export class LM {
  private model: any; // Native LanguageModel instance

  private constructor(model: any) {
    this.model = model;
  }

  /**
   * Create OpenAI provider
   *
   * @example
   * ```typescript
   * const lm = LM.openai({ apiKey: process.env.OPENAI_API_KEY });
   * const response = await lm.generate({
   *   model: 'gpt-4',
   *   messages: [{ role: 'user', content: 'Hello!' }]
   * });
   * ```
   */
  static openai(config?: OpenAIConfig): LM {
    const bindings = loadNativeBindings();
    return new LM(bindings.LanguageModel.openai(config));
  }

  /**
   * Create Anthropic (Claude) provider
   *
   * @example
   * ```typescript
   * const lm = LM.anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
   * const response = await lm.generate({
   *   model: 'claude-3-5-sonnet-20241022',
   *   messages: [{ role: 'user', content: 'Hello!' }]
   * });
   * ```
   */
  static anthropic(config?: AnthropicConfig): LM {
    const bindings = loadNativeBindings();
    return new LM(bindings.LanguageModel.anthropic(config));
  }

  /**
   * Create Azure OpenAI provider
   *
   * @example
   * ```typescript
   * const lm = LM.azure({
   *   apiKey: process.env.AZURE_OPENAI_API_KEY,
   *   endpoint: 'https://your-resource.openai.azure.com',
   * });
   * ```
   */
  static azure(config: AzureOpenAIConfig): LM {
    const bindings = loadNativeBindings();
    return new LM(bindings.LanguageModel.azure(config));
  }

  /**
   * Create AWS Bedrock provider
   *
   * @example
   * ```typescript
   * const lm = LM.bedrock({
   *   region: 'us-east-1',
   *   accessKeyId: process.env.AWS_ACCESS_KEY_ID,
   *   secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
   * });
   * ```
   */
  static bedrock(config: BedrockConfig): LM {
    const bindings = loadNativeBindings();
    return new LM(bindings.LanguageModel.bedrock(config));
  }

  /**
   * Create Groq provider (fast inference)
   *
   * @example
   * ```typescript
   * const lm = LM.groq({ apiKey: process.env.GROQ_API_KEY });
   * const response = await lm.generate({
   *   model: 'mixtral-8x7b-32768',
   *   messages: [{ role: 'user', content: 'Hello!' }]
   * });
   * ```
   */
  static groq(config?: GroqConfig): LM {
    const bindings = loadNativeBindings();
    return new LM(bindings.LanguageModel.groq(config));
  }

  /**
   * Create OpenRouter provider (model aggregation)
   *
   * @example
   * ```typescript
   * const lm = LM.openrouter({ apiKey: process.env.OPENROUTER_API_KEY });
   * const response = await lm.generate({
   *   model: 'anthropic/claude-3-opus',
   *   messages: [{ role: 'user', content: 'Hello!' }]
   * });
   * ```
   */
  static openrouter(config?: OpenRouterConfig): LM {
    const bindings = loadNativeBindings();
    return new LM(bindings.LanguageModel.openrouter(config));
  }

  /**
   * Generate a completion
   *
   * @example
   * ```typescript
   * const response = await lm.generate({
   *   model: 'gpt-4',
   *   messages: [
   *     { role: 'system', content: 'You are a helpful assistant.' },
   *     { role: 'user', content: 'What is 2+2?' }
   *   ],
   *   config: {
   *     temperature: 0.7,
   *     maxOutputTokens: 100
   *   }
   * });
   * console.log(response.text);
   * ```
   */
  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    return await this.model.generate(request);
  }

  /**
   * Stream a completion
   *
   * @example
   * ```typescript
   * await lm.stream({
   *   model: 'gpt-4',
   *   messages: [{ role: 'user', content: 'Tell me a story' }]
   * }, (chunk) => {
   *   if (chunk.chunkType === 'delta' && chunk.content) {
   *     process.stdout.write(chunk.content);
   *   } else if (chunk.chunkType === 'completed' && chunk.response) {
   *     console.log('\n\nTokens used:', chunk.response.usage);
   *   }
   * });
   * ```
   */
  async stream(
    request: GenerateRequest,
    callback: (chunk: StreamChunk) => void
  ): Promise<void> {
    return await this.model.stream(request, callback);
  }
}

// ============================================================================
// Helper functions
// ============================================================================

/**
 * Create a system message
 */
export function systemMessage(content: string): Message {
  return { role: 'system', content };
}

/**
 * Create a user message
 */
export function userMessage(content: string): Message {
  return { role: 'user', content };
}

/**
 * Create an assistant message
 */
export function assistantMessage(content: string): Message {
  return { role: 'assistant', content };
}

/**
 * Create a tool definition from a JSON schema
 */
export function createTool(
  name: string,
  description: string,
  parameters: JSONSchema
): ToolDefinition {
  return {
    name,
    description,
    parameters: JSON.stringify(parameters),
    strict: true,
  };
}

/**
 * Parse tool call arguments
 */
export function parseToolArguments<T = any>(toolCall: ToolCall): T {
  return JSON.parse(toolCall.arguments);
}

/**
 * Create a JSON schema response format
 */
export function jsonSchemaFormat(
  name: string,
  schema: JSONSchema,
  strict: boolean = true
): ResponseFormatOption {
  return {
    formatType: 'json_schema',
    schemaName: name,
    schema: JSON.stringify(schema),
    strict,
  };
}
