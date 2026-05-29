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
 * - DeepSeek
 * - Google (Gemini)
 * - Mistral
 * - Ollama (local LLM)
 * - xAI (Grok)
 * - HuggingFace
 * - OpenAI Chat (custom OpenAI-compatible APIs)
 */

import { ConfigurationError } from './errors.js';
import type { JSONSchema } from './types.js';
import { loadNativeBindings } from './native-loader.js';

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
  promptRef?: string | PromptRef;
  variables?: Record<string, string | number | boolean | null>;
  projectId?: string;
  environment?: string;
  environmentId?: string;
  promptVersion?: string;
  platformUrl?: string;
  apiKey?: string;
  systemPrompt?: string;
  messages?: Message[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoiceOption;
  userId?: string;
  config?: GenerationConfig;
}

export interface PromptRef {
  id: string;
  projectId?: string;
  version?: string;
  environmentId?: string;
  environmentRef?: string;
  platformUrl?: string;
  apiKey?: string;
  variables?: Record<string, string | number | boolean | null>;
}

export const SUPPORTED_MODEL_PROVIDERS = Object.freeze([
  'anthropic',
  'azure',
  'bedrock',
  'deepseek',
  'gemini',
  'google',
  'groq',
  'hf',
  'huggingface',
  'mistral',
  'ollama',
  'openai',
  'openai_chat',
  'openrouter',
  'xai',
]);

const SUPPORTED_MODEL_PROVIDER_SET = new Set<string>(SUPPORTED_MODEL_PROVIDERS);
const GATEWAY_PROVIDERS = new Set(['openrouter']);

const PROVIDER_ALIASES: Record<string, string[]> = {
  google: ['google', 'gemini'],
  huggingface: ['huggingface', 'hf'],
  openai_chat: ['openai_chat'],
};

export interface ParsedModelIdentifier {
  provider: string;
  modelName: string;
}

function providerList(): string {
  return SUPPORTED_MODEL_PROVIDERS.join(', ');
}

export function parseModelIdentifier(
  model: string,
  options: { allowUnknownProvider?: boolean } = {},
): ParsedModelIdentifier {
  if (typeof model !== 'string' || model.trim() === '') {
    throw new ConfigurationError("Model must be a non-empty string in 'provider/model' format");
  }

  if (!model.includes('/')) {
    throw new ConfigurationError(
      `Model must include provider prefix (e.g., 'openai/${model}'). ` +
      `Supported providers: ${providerList()}`,
    );
  }

  const [rawProvider, ...modelParts] = model.split('/');
  const provider = rawProvider.trim().toLowerCase();
  const modelName = modelParts.join('/').trim();

  if (!provider || !modelName) {
    throw new ConfigurationError(
      "Model must be in 'provider/model' format with both provider and model name",
    );
  }

  if (!options.allowUnknownProvider && !SUPPORTED_MODEL_PROVIDER_SET.has(provider)) {
    throw new ConfigurationError(
      `Unsupported model provider '${provider}' in model '${model}'. ` +
      `Did you mean 'openai/${modelName}'? ` +
      `Supported providers: ${providerList()}`,
    );
  }

  return { provider, modelName };
}

export function validateModelForProvider(model: string, sdkProvider?: string): string {
  const normalizedSdkProvider = sdkProvider?.toLowerCase();
  const parsed = parseModelIdentifier(model, {
    allowUnknownProvider: normalizedSdkProvider
      ? GATEWAY_PROVIDERS.has(normalizedSdkProvider)
      : false,
  });

  if (normalizedSdkProvider && !GATEWAY_PROVIDERS.has(normalizedSdkProvider)) {
    const allowedPrefixes = PROVIDER_ALIASES[normalizedSdkProvider] ?? [normalizedSdkProvider];
    if (!allowedPrefixes.includes(parsed.provider)) {
      throw new ConfigurationError(
        `Provider '${normalizedSdkProvider}' does not match model prefix '${parsed.provider}'. ` +
        `Use '${allowedPrefixes[0]}/${parsed.modelName}' or choose the matching LM provider.`,
      );
    }
  }

  return `${parsed.provider}/${parsed.modelName}`;
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

export interface DeepSeekConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface GoogleConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface MistralConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface OllamaConfig {
  baseUrl?: string;
  apiKey?: string;
}

export interface XaiConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface HuggingFaceConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface OpenAiChatConfig {
  apiKey?: string;
  baseUrl?: string;
  organization?: string;
}

// ============================================================================
// LM Class (TypeScript wrapper)
// ============================================================================

export class LM {
  private model: any; // Native LanguageModel instance
  readonly providerName: string;

  private constructor(model: any, providerName: string) {
    this.model = model;
    this.providerName = providerName;
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
    return new LM(bindings.LanguageModel.openai(config), 'openai');
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
    return new LM(bindings.LanguageModel.anthropic(config), 'anthropic');
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
    return new LM(bindings.LanguageModel.azure(config), 'azure');
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
    return new LM(bindings.LanguageModel.bedrock(config), 'bedrock');
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
    return new LM(bindings.LanguageModel.groq(config), 'groq');
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
    return new LM(bindings.LanguageModel.openrouter(config), 'openrouter');
  }

  /** Create DeepSeek provider */
  static deepseek(config?: DeepSeekConfig): LM {
    const bindings = loadNativeBindings();
    return new LM(bindings.LanguageModel.deepseek(config), 'deepseek');
  }

  /** Create Google (Gemini) provider */
  static google(config?: GoogleConfig): LM {
    const bindings = loadNativeBindings();
    return new LM(bindings.LanguageModel.google(config), 'google');
  }

  /** Create Mistral provider */
  static mistral(config?: MistralConfig): LM {
    const bindings = loadNativeBindings();
    return new LM(bindings.LanguageModel.mistral(config), 'mistral');
  }

  /** Create Ollama provider (local LLM) */
  static ollama(config?: OllamaConfig): LM {
    const bindings = loadNativeBindings();
    return new LM(bindings.LanguageModel.ollama(config), 'ollama');
  }

  /** Create xAI (Grok) provider */
  static xai(config?: XaiConfig): LM {
    const bindings = loadNativeBindings();
    return new LM(bindings.LanguageModel.xai(config), 'xai');
  }

  /** Create HuggingFace provider */
  static huggingface(config?: HuggingFaceConfig): LM {
    const bindings = loadNativeBindings();
    return new LM(bindings.LanguageModel.huggingface(config), 'huggingface');
  }

  /** Create OpenAI Chat-compatible provider (for custom OpenAI-compatible APIs) */
  static openaiChat(config?: OpenAiChatConfig): LM {
    const bindings = loadNativeBindings();
    return new LM(bindings.LanguageModel.openaiChat(config), 'openai_chat');
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
    if (request.promptRef) {
      return await runManagedPrompt(request);
    }
    return await this.model.generate({
      ...request,
      messages: request.messages ?? [],
      promptRef: undefined,
      model: validateModelForProvider(request.model, this.providerName),
    });
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
    if (request.promptRef) {
      callback({ chunkType: 'completed', response: await runManagedPrompt(request) });
      return;
    }
    return await this.model.stream({
      ...request,
      messages: request.messages ?? [],
      promptRef: undefined,
      model: validateModelForProvider(request.model, this.providerName),
    }, callback);
  }
}

async function runManagedPrompt(request: GenerateRequest): Promise<GenerateResponse> {
  const promptRef = normalizePromptRef(request);
  const projectId = promptRef.projectId || request.projectId || process.env.AGNT5_PROJECT_ID || process.env.AGNT5_PROJECT_REF;
  if (!projectId) {
    throw new ConfigurationError('Managed prompts require project context. Set projectId on the call or AGNT5_PROJECT_ID in the environment.');
  }
  const platformUrl = (promptRef.platformUrl || request.platformUrl || process.env.AGNT5_PLATFORM_URL || process.env.AGNT5_CONTROL_PLANE_URL || 'https://api.agnt5.com').replace(/\/$/, '');
  const body: Record<string, unknown> = {
    variables: request.variables ?? promptRef.variables ?? {},
  };
  const version = request.promptVersion || promptRef.version;
  const environmentId = request.environmentId || promptRef.environmentId || process.env.AGNT5_ENVIRONMENT_ID;
  const environmentRef = request.environment || promptRef.environmentRef || process.env.AGNT5_ENVIRONMENT || process.env.AGNT5_ENVIRONMENT_REF;
  if (version) body.version_id = version;
  if (environmentId) body.environment_id = environmentId;
  else if (environmentRef) body.environment_ref = environmentRef;
  if (request.config?.temperature !== undefined) body.temperature = request.config.temperature;
  if (request.config?.maxOutputTokens !== undefined) body.max_tokens = request.config.maxOutputTokens;

  const apiKey = promptRef.apiKey || request.apiKey || process.env.AGNT5_API_KEY;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers['X-API-KEY'] = apiKey;
  }

  const response = await fetch(`${platformUrl}/api/v1/projects/${projectId}/prompts/${promptRef.id}/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ConfigurationError(`Managed prompt request failed: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json() as any;
  const data = payload.data ?? payload;
  return {
    id: data.id ?? '',
    model: data.model ?? request.model,
    text: data.content ?? '',
    usage: data.total_tokens !== undefined ? {
      promptTokens: data.prompt_tokens ?? 0,
      completionTokens: data.completion_tokens ?? 0,
      totalTokens: data.total_tokens ?? 0,
    } : undefined,
    finishReason: data.finish_reason,
    raw: JSON.stringify(data),
  };
}

function normalizePromptRef(request: GenerateRequest): PromptRef {
  if (!request.promptRef) {
    throw new ConfigurationError('promptRef is required for managed prompt execution');
  }
  if (typeof request.promptRef === 'string') {
    return { id: request.promptRef };
  }
  return request.promptRef;
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
