import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigurationError } from './errors.js';
import type { GenerateRequest, Message, PromptRef, ResponseFormatOption } from './lm.js';

export const PROMPT_MANIFEST_SCHEMA_VERSION = 'agnt5.prompts.v1';
const DEFAULT_MANIFEST_FILE = 'prompts.lock';
const DEFAULT_PROMPT_DIR = 'prompts';
const PRODUCTION_ENVIRONMENTS = new Set(['prod', 'production']);
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;

interface ManifestPrompt {
  id?: string;
  public_id?: string;
  version?: string | number;
  model?: string;
  messages?: Array<{ role: string; content: unknown }>;
  variables?: string[];
  parameters?: Record<string, unknown>;
  model_config?: Record<string, unknown>;
  response_format?: string;
  response_schema?: Record<string, unknown>;
}

export function resolvePromptRefFromManifest(
  request: GenerateRequest,
  promptRef: PromptRef,
): GenerateRequest | null {
  const prompt = resolvePrompt(promptRef);
  if (!prompt) {
    return null;
  }

  const parameters = promptParameters(prompt);
  return {
    ...request,
    model: normalizePromptModel(prompt.model),
    promptRef: undefined,
    messages: renderMessages(prompt.messages ?? [], promptRef.variables ?? {}),
    systemPrompt: undefined,
    config: {
      ...request.config,
      temperature: request.config?.temperature ?? optionalNumber(parameters.temperature),
      maxOutputTokens:
        request.config?.maxOutputTokens ??
        optionalNumber(parameters.max_tokens ?? parameters.maxOutputTokens),
      topP: request.config?.topP ?? optionalNumber(parameters.top_p),
      responseFormat:
        request.config?.responseFormat ?? buildResponseFormat(prompt),
    },
  };
}

function resolvePrompt(promptRef: PromptRef): ManifestPrompt | null {
  const explicit = hasExplicitManifestSource();
  const manifestRequired = explicit || isProductionPromptRef(promptRef);

  for (const path of candidatePaths(promptRef.id)) {
    if (!existsSync(path)) {
      continue;
    }

    const prompt = findPrompt(loadJson(path), promptRef.id, promptRef.version);
    if (prompt) {
      return prompt;
    }
  }

  if (manifestRequired) {
    const versionSuffix = promptRef.version ? ` version ${JSON.stringify(promptRef.version)}` : '';
    throw new ConfigurationError(
      `Prompt ${JSON.stringify(promptRef.id)}${versionSuffix} was not found in the bundled ` +
        'prompt manifest. Production prompt refs must be committed to Git and included in ' +
        'the deploy artifact.',
    );
  }

  return null;
}

function hasExplicitManifestSource(): boolean {
  return Boolean(process.env.AGNT5_PROMPT_OVERRIDE || process.env.AGNT5_PROMPTS_MANIFEST);
}

function isProductionPromptRef(promptRef: PromptRef): boolean {
  const candidates = [
    promptRef.environmentRef,
    process.env.AGNT5_ENVIRONMENT,
    process.env.AGNT5_ENVIRONMENT_REF,
    process.env.AGNT5_ENV,
  ];
  return candidates.some((value) =>
    value ? PRODUCTION_ENVIRONMENTS.has(String(value).trim().toLowerCase()) : false,
  );
}

function candidatePaths(promptId: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  const add = (source?: string): void => {
    if (!source) return;
    for (const path of pathsForSource(source, promptId)) {
      const absolute = resolve(path);
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      result.push(absolute);
    }
  };

  add(process.env.AGNT5_PROMPT_OVERRIDE);
  add(process.env.AGNT5_PROMPTS_MANIFEST);
  add(process.cwd());

  return result;
}

function pathsForSource(source: string, promptId: string): string[] {
  if (source.endsWith('.json') || source.endsWith(DEFAULT_MANIFEST_FILE)) {
    return [source];
  }
  return [
    `${source}/${DEFAULT_MANIFEST_FILE}`,
    `${source}/${DEFAULT_PROMPT_DIR}/${promptId}.json`,
    `${source}/${promptId}.json`,
  ];
}

function loadJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigurationError(`Invalid prompt manifest JSON at ${path}: ${String(error)}`);
  }
}

function findPrompt(data: unknown, promptId: string, version?: string): ManifestPrompt | null {
  for (const prompt of iterPrompts(data)) {
    const candidateId = String(prompt.id ?? prompt.public_id ?? '');
    if (candidateId !== promptId) {
      continue;
    }
    if (version !== undefined && String(prompt.version ?? '') !== String(version)) {
      continue;
    }
    validatePrompt(prompt, promptId);
    return prompt;
  }
  return null;
}

function* iterPrompts(data: unknown): Iterable<ManifestPrompt> {
  if (!data || typeof data !== 'object') {
    return;
  }

  const record = data as Record<string, unknown>;
  const prompts = record.prompts;
  if (Array.isArray(prompts)) {
    for (const prompt of prompts) {
      if (prompt && typeof prompt === 'object') {
        yield prompt as ManifestPrompt;
      }
    }
  } else if (prompts && typeof prompts === 'object') {
    for (const [id, prompt] of Object.entries(prompts)) {
      if (prompt && typeof prompt === 'object') {
        yield { id, ...(prompt as ManifestPrompt) };
      }
    }
  }

  if ('id' in record && 'messages' in record) {
    yield record as ManifestPrompt;
  }
}

function validatePrompt(prompt: ManifestPrompt, promptId: string): void {
  if (!prompt.model) {
    throw new ConfigurationError(`Prompt ${JSON.stringify(promptId)} is missing model`);
  }
  if (!prompt.messages?.length) {
    throw new ConfigurationError(`Prompt ${JSON.stringify(promptId)} is missing messages`);
  }
}

function normalizePromptModel(model: unknown): string {
  if (typeof model !== 'string' || !model.trim()) {
    throw new ConfigurationError('Prompt manifest prompt.model must be a non-empty string');
  }
  const normalized = model.trim();
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
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function promptParameters(prompt: ManifestPrompt): Record<string, unknown> {
  if (prompt.parameters && typeof prompt.parameters === 'object') {
    return prompt.parameters;
  }
  if (prompt.model_config && typeof prompt.model_config === 'object') {
    return prompt.model_config;
  }
  return {};
}

function buildResponseFormat(prompt: ManifestPrompt): ResponseFormatOption | undefined {
  if (prompt.response_format === 'json_schema' && prompt.response_schema) {
    return {
      formatType: 'json_schema',
      schemaName: 'agnt5_prompt_output',
      schema: JSON.stringify(prompt.response_schema),
      strict: true,
    };
  }
  return undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return value == null ? undefined : Number(value);
}
