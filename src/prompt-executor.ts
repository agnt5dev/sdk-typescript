import { LM, type GenerateResponse, type Message, type ResponseFormatOption } from './lm.js';

export const PROMPT_EXECUTOR_COMPONENT_NAME = 'agnt5_prompt_executor';
export const PROMPT_EXECUTOR_ALIASES = new Set([PROMPT_EXECUTOR_COMPONENT_NAME, 'run_prompt']);
export const PROMPT_WORKER_INPUT_SCHEMA_VERSION = 'agnt5.eval.prompt_worker_input.v1';

export const PROMPT_EXECUTOR_METADATA: Record<string, string> = {
  source: 'agnt5_builtin',
  agnt5_builtin: 'prompt_executor',
  schema_version: PROMPT_WORKER_INPUT_SCHEMA_VERSION,
};

export interface PromptWorkerInput {
  schema_version: string;
  input?: unknown;
  variables?: Record<string, unknown>;
  prompt: {
    model: string;
    messages: Array<{ role: string; content: unknown }>;
    parameters?: {
      temperature?: number | null;
      max_tokens?: number | null;
      top_p?: number | null;
    };
    response_format?: string;
    response_schema?: Record<string, unknown>;
  };
}

export type PromptGenerateFn = (request: {
  model: string;
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  responseFormat?: ResponseFormatOption;
}) => Promise<GenerateResponse | string | unknown>;

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;

export function isPromptExecutorComponent(name: string): boolean {
  return PROMPT_EXECUTOR_ALIASES.has(name);
}

export async function executePromptWorkerInput(
  payload: PromptWorkerInput,
  generateFn: PromptGenerateFn = defaultGenerate,
): Promise<unknown> {
  validatePayload(payload);

  const variables = resolveVariables(payload);
  const messages = renderMessages(payload.prompt.messages, variables);
  const model = normalizePromptModel(payload.prompt.model);
  const parameters = payload.prompt.parameters ?? {};
  const responseFormat = buildResponseFormat(payload.prompt);

  const response = await generateFn({
    model,
    messages,
    temperature: optionalNumber(parameters.temperature),
    maxTokens: optionalNumber(parameters.max_tokens),
    topP: optionalNumber(parameters.top_p),
    responseFormat,
  });

  if (typeof response === 'string') {
    return parseJsonOutput(response);
  }

  if (response && typeof response === 'object' && 'text' in response) {
    const text = (response as GenerateResponse).text;
    return parseJsonOutput(text);
  }

  return response;
}

function validatePayload(payload: PromptWorkerInput): void {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Prompt executor input must be a JSON object');
  }
  if (payload.schema_version !== PROMPT_WORKER_INPUT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported prompt executor input schema ${JSON.stringify(payload.schema_version)}; ` +
        `expected ${JSON.stringify(PROMPT_WORKER_INPUT_SCHEMA_VERSION)}`,
    );
  }
  if (!payload.prompt || typeof payload.prompt !== 'object') {
    throw new Error('Prompt executor input must include a prompt object');
  }
  if (!payload.prompt.model) {
    throw new Error('Prompt executor prompt.model is required');
  }
  if (!payload.prompt.messages?.length) {
    throw new Error('Prompt executor prompt.messages is required');
  }
}

function resolveVariables(payload: PromptWorkerInput): Record<string, unknown> {
  if (payload.variables && typeof payload.variables === 'object') {
    return payload.variables;
  }

  if (payload.input && typeof payload.input === 'object' && !Array.isArray(payload.input)) {
    return payload.input as Record<string, unknown>;
  }

  return { input: payload.input };
}

function renderMessages(
  messages: Array<{ role: string; content: unknown }>,
  variables: Record<string, unknown>,
): Message[] {
  return messages.map((message) => ({
    role: message.role as Message['role'],
    content: renderValue(message.content, variables),
  }));
}

function renderValue(value: unknown, variables: Record<string, unknown>): string {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER_RE, (_match, expression: string) =>
      stringifyValue(lookupVariable(variables, expression, _match)),
    );
  }
  if (value && typeof value === 'object') {
    return JSON.stringify(renderNested(value, variables));
  }
  if (value == null) {
    return '';
  }
  return String(value);
}

function renderNested(value: unknown, variables: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER_RE, (_match, expression: string) =>
      stringifyValue(lookupVariable(variables, expression, _match)),
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderNested(item, variables));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderNested(item, variables)]),
    );
  }
  return value;
}

function lookupVariable(
  variables: Record<string, unknown>,
  expression: string,
  fallback: string,
): unknown {
  let current: unknown = variables;
  for (const part of expression.split('.')) {
    if (current && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part];
      continue;
    }
    return fallback;
  }
  return current;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value == null) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

export function normalizePromptModel(model: string): string {
  const normalized = model.trim();
  if (!normalized) {
    throw new Error('Prompt executor prompt.model must be a non-empty string');
  }
  if (normalized.includes('/')) {
    return normalized;
  }

  const lowered = normalized.toLowerCase();
  if (
    lowered.startsWith('gpt-') ||
    lowered.startsWith('chatgpt-') ||
    /^o[1-9](?:-|$)/.test(lowered)
  ) {
    return `openai/${normalized}`;
  }
  if (lowered.startsWith('claude-')) {
    return `anthropic/${normalized}`;
  }
  if (lowered.startsWith('gemini-')) {
    return `google/${normalized}`;
  }
  if (lowered.startsWith('mistral-')) {
    return `mistral/${normalized}`;
  }

  return normalized;
}

function buildResponseFormat(prompt: PromptWorkerInput['prompt']): ResponseFormatOption | undefined {
  if (
    prompt.response_format === 'json_schema' &&
    prompt.response_schema &&
    typeof prompt.response_schema === 'object'
  ) {
    return {
      formatType: 'json_schema',
      schemaName: 'agnt5_prompt_output',
      schema: JSON.stringify(prompt.response_schema),
      strict: true,
    };
  }

  return undefined;
}

function parseJsonOutput(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return text;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

function optionalNumber(value: number | null | undefined): number | undefined {
  return value == null ? undefined : Number(value);
}

async function defaultGenerate(request: {
  model: string;
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  responseFormat?: ResponseFormatOption;
}): Promise<GenerateResponse> {
  const provider = request.model.split('/', 1)[0];
  const client = createLMClient(provider);
  return await client.generate({
    model: request.model,
    messages: request.messages,
    config: {
      temperature: request.temperature,
      maxOutputTokens: request.maxTokens,
      topP: request.topP,
      responseFormat: request.responseFormat,
    },
  });
}

function createLMClient(provider: string): LM {
  switch (provider) {
    case 'openai':
      return LM.openai();
    case 'anthropic':
      return LM.anthropic();
    case 'groq':
      return LM.groq();
    case 'openrouter':
      return LM.openrouter();
    case 'deepseek':
      return LM.deepseek();
    case 'google':
    case 'gemini':
      return LM.google();
    case 'mistral':
      return LM.mistral();
    case 'ollama':
      return LM.ollama();
    case 'xai':
      return LM.xai();
    case 'huggingface':
    case 'hf':
      return LM.huggingface();
    default:
      throw new Error(`Unsupported prompt executor model provider: ${provider}`);
  }
}
