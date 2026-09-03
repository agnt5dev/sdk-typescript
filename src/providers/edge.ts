import type {
  AnthropicConfig,
  AzureOpenAIConfig,
  BasetenConfig,
  BedrockConfig,
  DeepSeekConfig,
  FireworksConfig,
  GenerateRequest,
  GenerateResponse,
  GoogleConfig,
  GroqConfig,
  HuggingFaceConfig,
  LeptonConfig,
  MistralConfig,
  MoonshotConfig,
  OllamaConfig,
  OpenAIConfig,
  OpenAiChatConfig,
  OpenRouterConfig,
  PromptCache,
  StreamChunk,
  TogetherConfig,
  ToolCall,
  XaiConfig,
} from '../lm.js';

export type EdgeProviderName =
  | 'openai'
  | 'anthropic'
  | 'azure'
  | 'baseten'
  | 'bedrock'
  | 'groq'
  | 'fireworks'
  | 'openrouter'
  | 'deepseek'
  | 'google'
  | 'mistral'
  | 'lepton'
  | 'ollama'
  | 'together'
  | 'xai'
  | 'moonshot'
  | 'huggingface'
  | 'openai_chat';

export type EdgeProviderConfig =
  | OpenAIConfig
  | AnthropicConfig
  | AzureOpenAIConfig
  | BasetenConfig
  | BedrockConfig
  | GroqConfig
  | FireworksConfig
  | OpenRouterConfig
  | DeepSeekConfig
  | GoogleConfig
  | MistralConfig
  | LeptonConfig
  | OllamaConfig
  | TogetherConfig
  | XaiConfig
  | MoonshotConfig
  | HuggingFaceConfig
  | OpenAiChatConfig
  | undefined;

export interface EdgeLanguageModel {
  generate(request: GenerateRequest): Promise<GenerateResponse>;
  stream(request: GenerateRequest, callback: (chunk: StreamChunk) => void): Promise<void>;
  createCache?(
    model: string,
    contents: string[],
    systemPrompt?: string,
    ttlSeconds?: number,
  ): Promise<string>;
  deleteCache?(name: string): Promise<void>;
}

type LooseConfig = Record<string, unknown>;
type JsonObject = Record<string, any>;

const CHAT_PROVIDER_DEFAULTS: Record<Exclude<
  EdgeProviderName,
  'openai' | 'anthropic' | 'azure' | 'bedrock' | 'google'
>, { baseUrl: string; apiKeyEnv?: string; preserveModel?: boolean; authScheme?: string }> = {
  baseten: {
    baseUrl: 'https://inference.baseten.co/v1',
    apiKeyEnv: 'BASETEN_API_KEY',
    authScheme: 'Api-Key',
  },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY' },
  fireworks: { baseUrl: 'https://api.fireworks.ai/inference/v1', apiKeyEnv: 'FIREWORKS_API_KEY' },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    preserveModel: true,
  },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', apiKeyEnv: 'MISTRAL_API_KEY' },
  lepton: { baseUrl: '', apiKeyEnv: 'LEPTON_API_KEY' },
  ollama: { baseUrl: 'http://localhost:11434/v1', apiKeyEnv: 'OLLAMA_API_KEY' },
  together: { baseUrl: 'https://api.together.ai/v1', apiKeyEnv: 'TOGETHER_API_KEY' },
  xai: { baseUrl: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_API_KEY' },
  moonshot: { baseUrl: 'https://api.moonshot.ai/v1', apiKeyEnv: 'MOONSHOT_API_KEY' },
  huggingface: {
    baseUrl: 'https://router.huggingface.co/v1',
    apiKeyEnv: 'HUGGINGFACE_API_KEY',
    preserveModel: true,
  },
  openai_chat: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
};

export function createEdgeLanguageModel(
  provider: EdgeProviderName,
  config: EdgeProviderConfig,
): EdgeLanguageModel {
  const loose = (config ?? {}) as LooseConfig;
  switch (provider) {
    case 'openai':
      return new OpenAIResponsesEdgeProvider(loose);
    case 'anthropic':
      return new AnthropicEdgeProvider(loose);
    case 'azure':
      return new AzureEdgeProvider(loose);
    case 'bedrock':
      return new BedrockEdgeProvider(loose);
    case 'google':
      return new GoogleEdgeProvider(loose);
    default:
      return new ChatCompletionsEdgeProvider(provider, loose, CHAT_PROVIDER_DEFAULTS[provider]);
  }
}

function env(name: string): string | undefined {
  const processEnv = (globalThis as any).process?.env as Record<string, string | undefined> | undefined;
  return processEnv?.[name];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function required(value: string | undefined, description: string): string {
  if (!value) throw new Error(`${description} is required for edge-runtime LM requests`);
  return value;
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function modelWithoutProvider(model: string, provider: string): string {
  const prefix = `${provider}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

function parseParameters(value: string | undefined): JsonObject {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    throw new Error(`Invalid tool parameters JSON: ${(error as Error).message}`);
  }
}

function cacheConfig(request: GenerateRequest): PromptCache | undefined {
  const config = request.config as (GenerateRequest['config'] & { cache?: PromptCache }) | undefined;
  const cache = config?.cache;
  return cache && typeof cache === 'object' ? cache : undefined;
}

function isOpenAIReasoningModel(model: string): boolean {
  return model.startsWith('gpt-5') || /^(o1|o3|o4)(-|$)/.test(model);
}

function responseFormatForChat(request: GenerateRequest): JsonObject | undefined {
  const format = request.config?.responseFormat;
  if (!format || format.formatType === 'text') return undefined;
  if (format.formatType === 'json') return { type: 'json_object' };
  return {
    type: 'json_schema',
    json_schema: {
      name: required(format.schemaName, 'responseFormat.schemaName'),
      schema: parseParameters(format.schema),
      strict: format.strict ?? true,
    },
  };
}

function chatPayload(request: GenerateRequest, model: string, stream: boolean): JsonObject {
  const messages = [
    ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
    ...chatMessages(request.messages ?? []),
  ];
  const reasoningModel = isOpenAIReasoningModel(model);
  const tools = request.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: parseParameters(tool.parameters),
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    },
  }));
  const toolChoice = request.toolChoice && (
    request.toolChoice.choiceType === 'tool'
      ? { type: 'function', function: { name: required(request.toolChoice.toolName, 'toolChoice.toolName') } }
      : request.toolChoice.choiceType
  );
  return compact({
    model,
    messages,
    stream: stream || undefined,
    temperature: reasoningModel ? undefined : request.config?.temperature,
    top_p: reasoningModel ? undefined : request.config?.topP,
    max_tokens: reasoningModel ? undefined : nonZero(request.config?.maxOutputTokens),
    max_completion_tokens: reasoningModel ? nonZero(request.config?.maxOutputTokens) : undefined,
    user: request.userId,
    response_format: responseFormatForChat(request),
    tools: tools?.length ? tools : undefined,
    tool_choice: toolChoice,
  });
}

function chatMessages(messages: NonNullable<GenerateRequest['messages']>): JsonObject[] {
  return messages.map(message => {
    if (message.toolCallId) {
      return compact({
        role: 'tool',
        content: message.content,
        tool_call_id: message.toolCallId,
        name: message.name,
      });
    }
    return compact({
      role: message.role,
      content: message.content,
      tool_calls: message.toolCalls?.map(call => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    });
  });
}

function nonZero(value: number | undefined): number | undefined {
  return value && value > 0 ? value : undefined;
}

function compact(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

async function apiError(response: Response, provider: string): Promise<Error> {
  const body = await response.text().catch(() => '');
  let message = body;
  try {
    const parsed = JSON.parse(body);
    message = parsed?.error?.message ?? parsed?.message ?? body;
  } catch {}
  return new Error(`${provider} API request failed (${response.status}): ${message || response.statusText}`);
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: JsonObject,
  provider: string,
): Promise<Response> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await apiError(response, provider);
  return response;
}

interface SseEvent {
  event?: string;
  data: string;
}

async function* readSse(response: Response): AsyncGenerator<SseEvent> {
  if (!response.body) throw new Error('LM streaming response did not include a body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const takeEvents = function* (flush = false): Generator<SseEvent> {
    while (true) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const parsed = parseSseBlock(block);
      if (parsed) yield parsed;
    }
    if (flush && buffer.trim()) {
      const parsed = parseSseBlock(buffer);
      buffer = '';
      if (parsed) yield parsed;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    yield* takeEvents();
  }
  buffer += decoder.decode();
  yield* takeEvents(true);
}

function parseSseBlock(block: string): SseEvent | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return data.length ? { event, data: data.join('\n') } : undefined;
}

function usageFromChat(usage: JsonObject | undefined): GenerateResponse['usage'] {
  if (!usage) return undefined;
  return compact({
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens,
  });
}

function responseFromChat(value: JsonObject): GenerateResponse {
  const choice = value.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const toolCalls = message.tool_calls?.map((tool: JsonObject, index: number) => ({
    id: tool.id ?? `call_${index}`,
    name: tool.function?.name ?? '',
    arguments: tool.function?.arguments ?? '',
  }));
  return compact({
    id: value.id ?? '',
    model: value.model ?? '',
    created: value.created,
    text: message.content ?? '',
    usage: usageFromChat(value.usage),
    finishReason: choice.finish_reason,
    toolCalls: toolCalls?.length ? toolCalls : undefined,
    raw: JSON.stringify(value),
  }) as GenerateResponse;
}

async function streamChatResponse(
  response: Response,
  callback: (chunk: StreamChunk) => void,
): Promise<void> {
  const state = {
    id: '',
    model: '',
    created: undefined as number | undefined,
    text: '',
    finishReason: undefined as string | undefined,
    usage: undefined as JsonObject | undefined,
    toolCalls: [] as Array<{ id?: string; name?: string; arguments: string }>,
  };

  for await (const event of readSse(response)) {
    if (event.data === '[DONE]') break;
    const chunk = JSON.parse(event.data) as JsonObject;
    state.id = chunk.id ?? state.id;
    state.model = chunk.model ?? state.model;
    state.created = chunk.created ?? state.created;
    state.usage = chunk.usage ?? state.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    state.finishReason = choice.finish_reason ?? state.finishReason;
    const content = choice.delta?.content;
    if (typeof content === 'string' && content) {
      state.text += content;
      callback({ chunkType: 'delta', content });
    }
    for (const delta of choice.delta?.tool_calls ?? []) {
      const index = delta.index ?? 0;
      while (state.toolCalls.length <= index) state.toolCalls.push({ arguments: '' });
      const partial = state.toolCalls[index];
      partial.id = delta.id ?? partial.id;
      partial.name = delta.function?.name ?? partial.name;
      partial.arguments += delta.function?.arguments ?? '';
    }
  }

  const toolCalls = state.toolCalls
    .filter(call => call.name)
    .map((call, index) => ({
      id: call.id ?? `call_${index}`,
      name: call.name!,
      arguments: call.arguments,
    }));
  callback({
    chunkType: 'completed',
    response: compact({
      id: state.id,
      model: state.model,
      created: state.created,
      text: state.text,
      usage: usageFromChat(state.usage),
      finishReason: state.finishReason,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    }) as GenerateResponse,
  });
}

class ChatCompletionsEdgeProvider implements EdgeLanguageModel {
  constructor(
    private readonly provider: Exclude<
      EdgeProviderName,
      'openai' | 'anthropic' | 'azure' | 'bedrock' | 'google'
    >,
    private readonly config: LooseConfig,
    private readonly defaults: {
      baseUrl: string;
      apiKeyEnv?: string;
      preserveModel?: boolean;
      authScheme?: string;
    },
  ) {}

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const response = await postJson(
      this.url(),
      this.headers(),
      chatPayload(request, this.model(request.model), false),
      this.provider,
    );
    return responseFromChat(await response.json() as JsonObject);
  }

  async stream(request: GenerateRequest, callback: (chunk: StreamChunk) => void): Promise<void> {
    const response = await postJson(
      this.url(),
      this.headers(),
      chatPayload(request, this.model(request.model), true),
      this.provider,
    );
    await streamChatResponse(response, callback);
  }

  private url(): string {
    const baseUrl = stringValue(this.config.baseUrl) ?? env(`${this.provider.toUpperCase()}_BASE_URL`) ?? this.defaults.baseUrl;
    return `${withoutTrailingSlash(required(baseUrl, `${this.provider} baseUrl`))}/chat/completions`;
  }

  private headers(): Record<string, string> {
    const apiKey = stringValue(this.config.apiKey) ?? (this.defaults.apiKeyEnv ? env(this.defaults.apiKeyEnv) : undefined);
    if (!apiKey && this.provider === 'ollama') return {};
    const authScheme = stringValue(this.config.authScheme) ?? this.defaults.authScheme ?? 'Bearer';
    const headers: Record<string, string> = {
      Authorization: `${authScheme} ${required(apiKey, `${this.provider} apiKey`)}`,
    };
    const organization = stringValue(this.config.organization);
    if (organization) headers['OpenAI-Organization'] = organization;
    return headers;
  }

  private model(model: string): string {
    return this.defaults.preserveModel ? model : modelWithoutProvider(model, this.provider);
  }
}

class AzureEdgeProvider implements EdgeLanguageModel {
  constructor(private readonly config: LooseConfig) {}

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const response = await postJson(this.url(request.model), this.headers(), chatPayload(
      request,
      modelWithoutProvider(request.model, 'azure'),
      false,
    ), 'azure');
    return responseFromChat(await response.json() as JsonObject);
  }

  async stream(request: GenerateRequest, callback: (chunk: StreamChunk) => void): Promise<void> {
    const response = await postJson(
      this.url(request.model),
      this.headers(),
      chatPayload(request, modelWithoutProvider(request.model, 'azure'), true),
      'azure',
    );
    await streamChatResponse(response, callback);
  }

  private azureDeploymentBase(model: string): string {
    const endpoint = withoutTrailingSlash(required(
      stringValue(this.config.endpoint),
      'Azure OpenAI endpoint',
    ));
    const deployment = encodeURIComponent(modelWithoutProvider(model, 'azure'));
    return `${endpoint}/openai/deployments/${deployment}`;
  }

  private url(model: string): string {
    const version = stringValue(this.config.apiVersion) ?? '2024-02-01';
    return `${this.azureDeploymentBase(model)}/chat/completions?api-version=${encodeURIComponent(version)}`;
  }

  private headers(): Record<string, string> {
    return {
      'api-key': required(
        stringValue(this.config.apiKey) ?? env('AZURE_OPENAI_API_KEY'),
        'Azure OpenAI apiKey',
      ),
    };
  }
}

class OpenAIResponsesEdgeProvider implements EdgeLanguageModel {
  constructor(private readonly config: LooseConfig) {}

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const response = await postJson(this.url(), this.headers(), this.payload(request, false), 'openai');
    return responseFromOpenAI(await response.json() as JsonObject);
  }

  async stream(request: GenerateRequest, callback: (chunk: StreamChunk) => void): Promise<void> {
    const response = await postJson(this.url(), this.headers(), this.payload(request, true), 'openai');
    let terminal: JsonObject | undefined;
    let text = '';
    let id = '';
    let model = '';
    let created: number | undefined;
    const partialTools = new Map<string, { id: string; name: string; arguments: string }>();

    for await (const event of readSse(response)) {
      if (event.data === '[DONE]') break;
      const value = JSON.parse(event.data) as JsonObject;
      const type = event.event ?? value.type;
      if (type === 'response.created') {
        const createdResponse = value.response ?? value;
        id = createdResponse.id ?? id;
        model = createdResponse.model ?? model;
        created = createdResponse.created_at ?? created;
      } else if (type === 'response.output_text.delta' && typeof value.delta === 'string') {
        text += value.delta;
        callback({ chunkType: 'delta', content: value.delta });
      } else if (type === 'response.function_call_arguments.delta') {
        const key = String(value.item_id ?? value.output_index ?? partialTools.size);
        const partial = partialTools.get(key) ?? { id: key, name: '', arguments: '' };
        partial.arguments += value.delta ?? '';
        partialTools.set(key, partial);
      } else if (type === 'response.function_call_arguments.done') {
        const key = String(value.item_id ?? value.output_index ?? partialTools.size);
        const partial = partialTools.get(key) ?? { id: key, name: '', arguments: '' };
        partial.id = value.call_id ?? partial.id;
        partial.name = value.name ?? partial.name;
        partial.arguments = value.arguments ?? partial.arguments;
        partialTools.set(key, partial);
      } else if (type === 'response.completed') {
        terminal = value.response ?? value;
      } else if (type === 'response.failed' || type === 'response.incomplete' || type === 'error') {
        const failure = value.response ?? value;
        throw new Error(failure.error?.message ?? failure.message ?? `OpenAI stream ${type}`);
      }
    }

    const completed = terminal
      ? responseFromOpenAI(terminal)
      : compact({
          id,
          model,
          created,
          text,
          finishReason: 'completed',
          toolCalls: Array.from(partialTools.values()).filter(tool => tool.name),
        }) as GenerateResponse;
    if (!completed.text && text) completed.text = text;
    callback({ chunkType: 'completed', response: completed });
  }

  private url(): string {
    const baseUrl = stringValue(this.config.baseUrl) ?? env('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1';
    return `${withoutTrailingSlash(baseUrl)}/responses`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${required(
        stringValue(this.config.apiKey) ?? env('OPENAI_API_KEY'),
        'OpenAI apiKey',
      )}`,
    };
    const organization = stringValue(this.config.organizationId) ?? env('OPENAI_ORGANIZATION');
    if (organization) headers['OpenAI-Organization'] = organization;
    return headers;
  }

  private payload(request: GenerateRequest, stream: boolean): JsonObject {
    const model = modelWithoutProvider(request.model, 'openai');
    const reasoningModel = isOpenAIReasoningModel(model);
    const tools = [
      ...(request.tools?.map(tool => compact({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: parseParameters(tool.parameters),
        strict: tool.strict,
      })) ?? []),
      ...(request.config?.builtInTools ?? [])
        .map(tool => {
          if (tool === 'web_search') return { type: 'web_search_preview' };
          if (tool === 'code_interpreter') return { type: 'code_interpreter' };
          if (tool === 'file_search') return { type: 'file_search' };
          return undefined;
        })
        .filter(Boolean),
    ];
    const format = request.config?.responseFormat;
    const textFormat = format && format.formatType !== 'text'
      ? {
          format: format.formatType === 'json'
            ? { type: 'json_object' }
            : {
                type: 'json_schema',
                name: required(format.schemaName, 'responseFormat.schemaName'),
                schema: parseParameters(format.schema),
                strict: format.strict ?? true,
              },
        }
      : undefined;
    const toolChoice = request.toolChoice && (
      request.toolChoice.choiceType === 'tool'
        ? { type: 'function', name: required(request.toolChoice.toolName, 'toolChoice.toolName') }
        : request.toolChoice.choiceType
    );
    const cache = cacheConfig(request);
    const input = request.messages?.length
      ? openAIResponsesInput(request.messages)
      : request.systemPrompt ?? '';
    return compact({
      model,
      input,
      instructions: request.systemPrompt,
      store: Boolean(request.tools?.length),
      stream: stream || undefined,
      prompt_cache_key: cache?.key,
      prompt_cache_retention: cache?.retention,
      temperature: reasoningModel ? undefined : request.config?.temperature,
      top_p: reasoningModel ? undefined : request.config?.topP,
      max_output_tokens: nonZero(request.config?.maxOutputTokens),
      tools: tools.length ? tools : undefined,
      tool_choice: toolChoice,
      modalities: request.config?.modalities,
      reasoning: request.config?.reasoningEffort
        ? { effort: request.config.reasoningEffort }
        : undefined,
      text: textFormat,
    });
  }
}

function openAIResponsesInput(messages: NonNullable<GenerateRequest['messages']>): JsonObject[] {
  const input: JsonObject[] = [];
  for (const message of messages) {
    if (message.toolCallId) {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: message.content,
      });
      continue;
    }
    if (message.toolCalls?.length) {
      if (message.content) {
        input.push({ type: 'message', role: 'assistant', content: message.content });
      }
      input.push(...message.toolCalls.map(call => ({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
      })));
      continue;
    }
    input.push({ type: 'message', role: message.role, content: message.content });
  }
  return input;
}

function responseFromOpenAI(value: JsonObject): GenerateResponse {
  if (value.status && value.status !== 'completed') {
    throw new Error(value.error?.message ?? `OpenAI Responses API returned status '${value.status}'`);
  }
  const text = (value.output ?? [])
    .filter((item: JsonObject) => item.type === 'message')
    .flatMap((item: JsonObject) => item.content ?? [])
    .filter((content: JsonObject) => content.type === 'output_text' || content.type === 'text')
    .map((content: JsonObject) => content.text ?? '')
    .join('\n');
  const toolCalls: ToolCall[] = [];
  for (const item of value.output ?? []) {
    if (item.type === 'function_call') {
      toolCalls.push({ id: item.call_id ?? item.id ?? '', name: item.name ?? '', arguments: item.arguments ?? '' });
    } else if (item.type === 'web_search_call' || item.type === 'code_interpreter_call' || item.type === 'file_search_call') {
      const { id, type: _type, status: _status, ...argumentsValue } = item;
      toolCalls.push({
        id: id ?? '',
        name: item.type.replace(/_call$/, ''),
        arguments: JSON.stringify(argumentsValue),
      });
    }
  }
  const usage = value.usage;
  return compact({
    id: value.id ?? '',
    model: value.model ?? '',
    created: value.created_at,
    text,
    usage: usage && compact({
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
      cachedTokens: usage.input_tokens_details?.cached_tokens,
    }),
    finishReason: value.status,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    raw: JSON.stringify(value),
  }) as GenerateResponse;
}

class AnthropicEdgeProvider implements EdgeLanguageModel {
  constructor(private readonly config: LooseConfig) {}

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const response = await postJson(this.url(), this.headers(), this.payload(request, false), 'anthropic');
    return responseFromAnthropic(await response.json() as JsonObject);
  }

  async stream(request: GenerateRequest, callback: (chunk: StreamChunk) => void): Promise<void> {
    const response = await postJson(this.url(), this.headers(), this.payload(request, true), 'anthropic');
    const state = {
      id: '', model: modelWithoutProvider(request.model, 'anthropic'), text: '',
      finishReason: undefined as string | undefined,
      promptTokens: undefined as number | undefined,
      completionTokens: undefined as number | undefined,
      cachedTokens: undefined as number | undefined,
      cacheCreationTokens: undefined as number | undefined,
      tools: new Map<number, { id: string; name: string; arguments: string }>(),
    };
    for await (const event of readSse(response)) {
      const value = JSON.parse(event.data) as JsonObject;
      const type = event.event ?? value.type;
      if (type === 'error') throw new Error(value.error?.message ?? 'Anthropic streaming request failed');
      if (type === 'message_start') {
        state.id = value.message?.id ?? state.id;
        state.model = value.message?.model ?? state.model;
        state.promptTokens = value.message?.usage?.input_tokens;
        state.cachedTokens = value.message?.usage?.cache_read_input_tokens;
        state.cacheCreationTokens = value.message?.usage?.cache_creation_input_tokens;
      } else if (type === 'content_block_start' && value.content_block?.type === 'tool_use') {
        state.tools.set(value.index ?? 0, {
          id: value.content_block.id ?? `call_${value.index ?? 0}`,
          name: value.content_block.name ?? '',
          arguments: value.content_block.input && Object.keys(value.content_block.input).length
            ? JSON.stringify(value.content_block.input)
            : '',
        });
      } else if (type === 'content_block_delta') {
        if (value.delta?.type === 'text_delta' && value.delta.text) {
          state.text += value.delta.text;
          callback({ chunkType: 'delta', content: value.delta.text });
        } else if (value.delta?.type === 'input_json_delta') {
          const index = value.index ?? 0;
          const tool = state.tools.get(index) ?? { id: `call_${index}`, name: '', arguments: '' };
          tool.arguments += value.delta.partial_json ?? '';
          state.tools.set(index, tool);
        }
      } else if (type === 'message_delta') {
        state.finishReason = value.delta?.stop_reason ?? state.finishReason;
        state.completionTokens = value.usage?.output_tokens ?? state.completionTokens;
      }
    }
    const usage = compact({
      promptTokens: state.promptTokens,
      completionTokens: state.completionTokens,
      totalTokens: state.promptTokens !== undefined && state.completionTokens !== undefined
        ? state.promptTokens + state.completionTokens
        : undefined,
      cachedTokens: state.cachedTokens,
      cacheCreationTokens: state.cacheCreationTokens,
    });
    callback({
      chunkType: 'completed',
      response: compact({
        id: state.id,
        model: state.model,
        text: state.text,
        usage: Object.keys(usage).length ? usage : undefined,
        finishReason: state.finishReason,
        toolCalls: state.tools.size ? Array.from(state.tools.values()) : undefined,
      }) as GenerateResponse,
    });
  }

  private url(): string {
    const baseUrl = stringValue(this.config.baseUrl) ?? env('ANTHROPIC_BASE_URL') ?? 'https://api.anthropic.com';
    return `${withoutTrailingSlash(baseUrl)}/v1/messages`;
  }

  private headers(): Record<string, string> {
    return {
      'x-api-key': required(stringValue(this.config.apiKey) ?? env('ANTHROPIC_API_KEY'), 'Anthropic apiKey'),
      'anthropic-version': '2023-06-01',
    };
  }

  private payload(request: GenerateRequest, stream: boolean): JsonObject {
    const cache = cacheConfig(request);
    const system = request.systemPrompt && cache?.enabled
      ? [{
          type: 'text',
          text: request.systemPrompt,
          cache_control: compact({ type: 'ephemeral', ttl: cache.ttl }),
        }]
      : request.systemPrompt;
    const tools = [
      ...(request.tools?.map(tool => compact({
        name: tool.name,
        description: tool.description,
        input_schema: parseParameters(tool.parameters),
      })) ?? []),
      ...(request.config?.builtInTools ?? []).flatMap(tool => {
        if (tool === 'web_search') return [{ type: 'web_search_20260209', name: 'web_search' }];
        if (tool === 'web_fetch') return [{ type: 'web_fetch_20260209', name: 'web_fetch' }];
        return [];
      }),
    ];
    const toolChoice = request.toolChoice && (
      request.toolChoice.choiceType === 'tool'
        ? { type: 'tool', name: required(request.toolChoice.toolName, 'toolChoice.toolName') }
        : request.toolChoice.choiceType === 'none'
          ? undefined
          : { type: request.toolChoice.choiceType }
    );
    return compact({
      model: modelWithoutProvider(request.model, 'anthropic'),
      system,
      messages: anthropicMessages(request.messages ?? []),
      max_tokens: request.config?.maxOutputTokens ?? 4096,
      temperature: request.config?.temperature,
      top_p: request.config?.topP,
      tools: tools.length ? tools : undefined,
      tool_choice: toolChoice,
      stream: stream || undefined,
    });
  }
}

function anthropicMessages(messages: NonNullable<GenerateRequest['messages']>): JsonObject[] {
  return messages.map(message => {
    if (message.toolCallId) {
      return {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
        }],
      };
    }
    if (message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: [
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
          ...message.toolCalls.map(call => ({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: parseJsonObject(call.arguments),
          })),
        ],
      };
    }
    return { role: message.role, content: message.content };
  });
}

function responseFromAnthropic(value: JsonObject): GenerateResponse {
  const text = (value.content ?? [])
    .filter((block: JsonObject) => block.type === 'text')
    .map((block: JsonObject) => block.text ?? '')
    .join('');
  const toolCalls = (value.content ?? [])
    .filter((block: JsonObject) => block.type === 'tool_use')
    .map((block: JsonObject, index: number) => ({
      id: block.id ?? `call_${index}`,
      name: block.name ?? '',
      arguments: JSON.stringify(block.input ?? {}),
    }));
  const usage = value.usage;
  return compact({
    id: value.id ?? '',
    model: value.model ?? '',
    text,
    usage: usage && compact({
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      totalTokens: typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number'
        ? usage.input_tokens + usage.output_tokens
        : undefined,
      cachedTokens: usage.cache_read_input_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens,
    }),
    finishReason: value.stop_reason,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    raw: JSON.stringify(value),
  }) as GenerateResponse;
}

class GoogleEdgeProvider implements EdgeLanguageModel {
  constructor(private readonly config: LooseConfig) {}

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const model = modelWithoutProvider(modelWithoutProvider(request.model, 'gemini'), 'google');
    const response = await postJson(this.modelUrl(model, 'generateContent'), {}, this.payload(request), 'google');
    return responseFromGoogle(await response.json() as JsonObject, model);
  }

  async stream(request: GenerateRequest, callback: (chunk: StreamChunk) => void): Promise<void> {
    const model = modelWithoutProvider(modelWithoutProvider(request.model, 'gemini'), 'google');
    const response = await postJson(this.modelUrl(model, 'streamGenerateContent', true), {}, this.payload(request), 'google');
    let text = '';
    let finishReason: string | undefined;
    let usage: JsonObject | undefined;
    const toolCalls: ToolCall[] = [];
    for await (const event of readSse(response)) {
      const value = JSON.parse(event.data) as JsonObject;
      const candidate = value.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (typeof part.text === 'string' && part.text) {
          text += part.text;
          callback({ chunkType: 'delta', content: part.text });
        }
        if (part.functionCall) {
          toolCalls.push({
            id: part.functionCall.id ?? `call_${toolCalls.length}`,
            name: part.functionCall.name ?? '',
            arguments: JSON.stringify(part.functionCall.args ?? {}),
            providerData: part.thoughtSignature
              ? { google: { thought_signature: part.thoughtSignature } }
              : undefined,
          });
        }
      }
      finishReason = candidate?.finishReason ?? finishReason;
      usage = value.usageMetadata ?? usage;
    }
    callback({
      chunkType: 'completed',
      response: compact({
        id: '',
        model,
        text,
        usage: usageFromGoogle(usage),
        finishReason,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      }) as GenerateResponse,
    });
  }

  async createCache(
    model: string,
    contents: string[],
    systemPrompt?: string,
    ttlSeconds?: number,
  ): Promise<string> {
    const normalized = modelWithoutProvider(modelWithoutProvider(model, 'gemini'), 'google');
    const response = await postJson(`${this.baseUrl()}/cachedContents?key=${encodeURIComponent(this.apiKey())}`, {}, compact({
      model: `models/${normalized}`,
      contents: [{ role: 'user', parts: contents.map(text => ({ text })) }],
      systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
      ttl: ttlSeconds ? `${ttlSeconds}s` : undefined,
    }), 'google');
    const value = await response.json() as JsonObject;
    return required(value.name, 'Google cached content name');
  }

  async deleteCache(name: string): Promise<void> {
    const normalized = name.startsWith('cachedContents/') ? name : `cachedContents/${name}`;
    const response = await fetch(`${this.baseUrl()}/${normalized}?key=${encodeURIComponent(this.apiKey())}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw await apiError(response, 'google');
  }

  private payload(request: GenerateRequest): JsonObject {
    const tools = request.tools?.map(tool => compact({
      name: tool.name,
      description: tool.description,
      parameters: parseParameters(tool.parameters),
    }));
    const toolChoice = request.toolChoice;
    const mode = toolChoice?.choiceType === 'none'
      ? 'NONE'
      : toolChoice?.choiceType === 'tool'
        ? 'ANY'
        : 'AUTO';
    const responseFormat = request.config?.responseFormat;
    const generationConfig = compact({
      temperature: request.config?.temperature,
      topP: request.config?.topP,
      maxOutputTokens: nonZero(request.config?.maxOutputTokens),
      responseMimeType: responseFormat?.formatType === 'json' || responseFormat?.formatType === 'json_schema'
        ? 'application/json'
        : undefined,
      responseJsonSchema: responseFormat?.formatType === 'json_schema'
        ? parseParameters(responseFormat.schema)
        : undefined,
      thinkingConfig: request.config?.reasoningEffort
        ? { thinkingLevel: request.config.reasoningEffort }
        : undefined,
    });
    const cache = cacheConfig(request);
    return compact({
      systemInstruction: request.systemPrompt ? { parts: [{ text: request.systemPrompt }] } : undefined,
      contents: googleContents(request.messages ?? []),
      tools: tools?.length || request.config?.builtInTools?.includes('web_search')
        ? [
            ...(tools?.length ? [{ functionDeclarations: tools }] : []),
            ...(request.config?.builtInTools?.includes('web_search') ? [{ google_search: {} }] : []),
          ]
        : undefined,
      toolConfig: toolChoice ? {
        functionCallingConfig: compact({
          mode,
          allowedFunctionNames: toolChoice.choiceType === 'tool' && toolChoice.toolName
            ? [toolChoice.toolName]
            : undefined,
        }),
      } : undefined,
      generationConfig: Object.keys(generationConfig).length ? generationConfig : undefined,
      cachedContent: cache?.resource,
    });
  }

  private modelUrl(model: string, operation: string, sse = false): string {
    const suffix = sse ? '&alt=sse' : '';
    return `${this.baseUrl()}/models/${encodeURIComponent(model)}:${operation}?key=${encodeURIComponent(this.apiKey())}${suffix}`;
  }

  private baseUrl(): string {
    return withoutTrailingSlash(
      stringValue(this.config.baseUrl) ?? env('GOOGLE_BASE_URL') ?? 'https://generativelanguage.googleapis.com/v1beta',
    );
  }

  private apiKey(): string {
    return required(
      stringValue(this.config.apiKey) ?? env('GOOGLE_API_KEY') ?? env('GEMINI_API_KEY'),
      'Google apiKey',
    );
  }
}

function responseFromGoogle(value: JsonObject, model: string): GenerateResponse {
  const candidate = value.candidates?.[0] ?? {};
  const parts = candidate.content?.parts ?? [];
  const text = parts.filter((part: JsonObject) => typeof part.text === 'string').map((part: JsonObject) => part.text).join('');
  const toolCalls = parts
    .filter((part: JsonObject) => part.functionCall)
    .map((part: JsonObject, index: number) => ({
      id: part.functionCall.id ?? `call_${index}`,
      name: part.functionCall.name ?? '',
      arguments: JSON.stringify(part.functionCall.args ?? {}),
      providerData: part.thoughtSignature
        ? { google: { thought_signature: part.thoughtSignature } }
        : undefined,
    }));
  return compact({
    id: value.responseId ?? '',
    model: value.modelVersion ?? model,
    text,
    usage: usageFromGoogle(value.usageMetadata),
    finishReason: candidate.finishReason,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    raw: JSON.stringify(value),
  }) as GenerateResponse;
}

function googleContents(messages: NonNullable<GenerateRequest['messages']>): JsonObject[] {
  const toolCallNames = new Map<string, string>();
  return messages.map(message => {
    if (message.toolCallId) {
      return {
        role: 'user',
        parts: [{
          functionResponse: {
            name: message.name ?? toolCallNames.get(message.toolCallId) ?? message.toolCallId,
            response: googleFunctionResponse(message.content),
            id: message.toolCallId,
          },
        }],
      };
    }

    if (message.toolCalls?.length) {
      const parts: JsonObject[] = message.content ? [{ text: message.content }] : [];
      for (const call of message.toolCalls) {
        toolCallNames.set(call.id, call.name);
        const providerData = typeof call.providerData === 'string'
          ? parseJsonObject(call.providerData)
          : call.providerData as JsonObject | undefined;
        const signature = providerData?.google?.thought_signature;
        parts.push(compact({
          functionCall: {
            id: call.id,
            name: call.name,
            args: parseJsonObject(call.arguments),
          },
          thoughtSignature: signature,
        }));
      }
      return { role: 'model', parts };
    }

    return {
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    };
  });
}

function googleFunctionResponse(content: string): JsonObject {
  try {
    const value = JSON.parse(content);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : { result: value };
  } catch {
    return { result: content };
  }
}

function parseJsonObject(value: string): JsonObject {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function usageFromGoogle(usage: JsonObject | undefined): GenerateResponse['usage'] {
  if (!usage) return undefined;
  return compact({
    promptTokens: usage.promptTokenCount,
    completionTokens: usage.candidatesTokenCount,
    totalTokens: usage.totalTokenCount,
    cachedTokens: usage.cachedContentTokenCount,
  });
}

class BedrockEdgeProvider implements EdgeLanguageModel {
  constructor(private readonly config: LooseConfig) {}

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const { region, model } = this.target(request.model);
    const body = compact({
      system: request.systemPrompt ? [{ text: request.systemPrompt }] : undefined,
      messages: bedrockMessages(request.messages ?? []),
      inferenceConfig: compact({
        maxTokens: nonZero(request.config?.maxOutputTokens),
        temperature: request.config?.temperature,
        topP: request.config?.topP,
      }),
      toolConfig: request.tools?.length ? compact({
        tools: request.tools.map(tool => ({
          toolSpec: compact({
            name: tool.name,
            description: tool.description,
            inputSchema: { json: parseParameters(tool.parameters) },
          }),
        })),
        toolChoice: bedrockToolChoice(request),
      }) : undefined,
    });
    const url = `${this.endpoint(region)}/model/${encodeURIComponent(model)}/converse`;
    const serialized = JSON.stringify(body);
    const headers = await this.signedHeaders(url, serialized, region);
    const response = await fetch(url, { method: 'POST', headers, body: serialized });
    if (!response.ok) throw await apiError(response, 'bedrock');
    return responseFromBedrock(await response.json() as JsonObject, model);
  }

  async stream(request: GenerateRequest, callback: (chunk: StreamChunk) => void): Promise<void> {
    // Bedrock's ConverseStream body uses AWS event-stream framing rather than
    // SSE. Preserve the SDK streaming contract on isolates by using Converse
    // and emitting its accepted final as one delta plus the terminal response.
    const response = await this.generate(request);
    if (response.text) callback({ chunkType: 'delta', content: response.text });
    callback({ chunkType: 'completed', response });
  }

  private endpoint(region: string): string {
    return `https://bedrock-runtime.${region}.amazonaws.com`;
  }

  private target(modelIdentifier: string): { region: string; model: string } {
    const rest = modelWithoutProvider(modelIdentifier, 'bedrock');
    const separator = rest.indexOf('/');
    if (separator > 0) {
      const candidateRegion = rest.slice(0, separator);
      if (/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(candidateRegion)) {
        return { region: candidateRegion, model: required(rest.slice(separator + 1), 'Bedrock model') };
      }
    }
    return {
      region: required(
        stringValue(this.config.region) ?? env('AWS_REGION') ?? env('AWS_DEFAULT_REGION'),
        'AWS region',
      ),
      model: required(rest, 'Bedrock model'),
    };
  }

  private async signedHeaders(
    urlString: string,
    body: string,
    region: string,
  ): Promise<Record<string, string>> {
    const accessKey = required(stringValue(this.config.accessKeyId) ?? env('AWS_ACCESS_KEY_ID'), 'AWS accessKeyId');
    const secretKey = required(stringValue(this.config.secretAccessKey) ?? env('AWS_SECRET_ACCESS_KEY'), 'AWS secretAccessKey');
    const sessionToken = stringValue(this.config.sessionToken) ?? env('AWS_SESSION_TOKEN');
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const service = 'bedrock';
    const url = new URL(urlString);
    const canonicalHeaders = [
      `content-type:application/json`,
      `host:${url.host}`,
      `x-amz-date:${amzDate}`,
      ...(sessionToken ? [`x-amz-security-token:${sessionToken}`] : []),
    ].join('\n') + '\n';
    const signedHeaders = ['content-type', 'host', 'x-amz-date', ...(sessionToken ? ['x-amz-security-token'] : [])].join(';');
    const canonicalRequest = [
      'POST',
      url.pathname,
      '',
      canonicalHeaders,
      signedHeaders,
      await sha256Hex(body),
    ].join('\n');
    const scope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
    const dateKey = await hmac(new TextEncoder().encode(`AWS4${secretKey}`), dateStamp);
    const regionKey = await hmac(dateKey, region);
    const serviceKey = await hmac(regionKey, service);
    const signingKey = await hmac(serviceKey, 'aws4_request');
    const signature = toHex(await hmac(signingKey, stringToSign));
    return {
      'Content-Type': 'application/json',
      'X-Amz-Date': amzDate,
      ...(sessionToken ? { 'X-Amz-Security-Token': sessionToken } : {}),
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }
}

function bedrockMessages(messages: NonNullable<GenerateRequest['messages']>): JsonObject[] {
  return messages.map(message => {
    if (message.toolCallId) {
      return {
        role: 'user',
        content: [{
          toolResult: {
            toolUseId: message.toolCallId,
            content: [{ json: googleFunctionResponse(message.content) }],
          },
        }],
      };
    }
    if (message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: [
          ...(message.content ? [{ text: message.content }] : []),
          ...message.toolCalls.map(call => ({
            toolUse: {
              toolUseId: call.id,
              name: call.name,
              input: parseJsonObject(call.arguments),
            },
          })),
        ],
      };
    }
    return {
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: [{ text: message.content }],
    };
  });
}

function bedrockToolChoice(request: GenerateRequest): JsonObject | undefined {
  const choice = request.toolChoice;
  if (!choice) return undefined;
  if (choice.choiceType === 'none') return undefined;
  if (choice.choiceType === 'auto') return { auto: {} };
  return { tool: { name: required(choice.toolName, 'toolChoice.toolName') } };
}

function responseFromBedrock(value: JsonObject, model: string): GenerateResponse {
  const content = value.output?.message?.content ?? [];
  const text = content.filter((block: JsonObject) => typeof block.text === 'string').map((block: JsonObject) => block.text).join('');
  const toolCalls = content
    .filter((block: JsonObject) => block.toolUse)
    .map((block: JsonObject, index: number) => ({
      id: block.toolUse.toolUseId ?? `call_${index}`,
      name: block.toolUse.name ?? '',
      arguments: JSON.stringify(block.toolUse.input ?? {}),
    }));
  const usage = value.usage;
  return compact({
    id: value.$metadata?.requestId ?? '',
    model,
    text,
    usage: usage && compact({
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    }),
    finishReason: value.stopReason,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    raw: JSON.stringify(value),
  }) as GenerateResponse;
}

async function sha256Hex(value: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(value)));
}

function toHex(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
}
