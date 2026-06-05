import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { ConfigurationError } from './errors.js';
import type { GenerateRequest, Message, Prompt, ResponseFormatOption } from './lm.js';

export const PROMPT_MANIFEST_SCHEMA_VERSION = 'agnt5.prompts.v1';
const DEFAULT_PROMPT_DIR = 'prompts';
const PRODUCTION_ENVIRONMENTS = new Set(['prod', 'production']);
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;
const MDX_PROMPT_EXTENSIONS = new Set(['.md', '.mdx']);
const MDX_ROLE_BLOCK_RE = /<(System|User|Assistant)>\s*([\s\S]*?)\s*<\/\1>/gi;
const FRONTMATTER_PARAMETER_KEYS = new Set([
  'temperature',
  'max_tokens',
  'max_output_tokens',
  'top_p',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'stop_sequences',
]);

interface ManifestPrompt {
  id?: string;
  public_id?: string;
  version?: string | number;
  version_id?: string;
  model?: string;
  messages?: Array<{ role: string; content: unknown }>;
  variables?: string[];
  parameters?: Record<string, unknown>;
  model_config?: Record<string, unknown>;
  response_format?: string;
  response_schema?: Record<string, unknown>;
  response_schema_json?: string;
  tools?: unknown[];
  tools_json?: string;
}

export function resolvePromptFromManifest(
  request: GenerateRequest,
  prompt: Prompt,
): GenerateRequest | null {
  const manifestPrompt = resolvePrompt(prompt);
  if (!manifestPrompt) {
    return null;
  }

  const parameters = promptParameters(manifestPrompt);
  return {
    ...request,
    model: normalizePromptModel(prompt.model ?? manifestPrompt.model),
    prompt: undefined,
    promptRef: undefined,
    messages: renderMessages(manifestPrompt.messages ?? [], prompt.variables ?? {}),
    systemPrompt: undefined,
    config: {
      ...request.config,
      temperature:
        request.config?.temperature ??
        prompt.temperature ??
        optionalNumber(parameters.temperature),
      maxOutputTokens:
        request.config?.maxOutputTokens ??
        prompt.maxOutputTokens ??
        optionalNumber(parameters.max_tokens ?? parameters.maxOutputTokens),
      topP: request.config?.topP ?? prompt.topP ?? optionalNumber(parameters.top_p),
      responseFormat:
        request.config?.responseFormat ?? buildResponseFormat(manifestPrompt),
    },
  };
}

/** @deprecated Use resolvePromptFromManifest. */
export const resolvePromptRefFromManifest = resolvePromptFromManifest;

function resolvePrompt(prompt: Prompt): ManifestPrompt | null {
  const explicit = hasExplicitManifestSource();
  const manifestRequired = explicit || isProductionPrompt(prompt);

  for (const path of candidatePaths(prompt.id)) {
    if (!existsSync(path)) {
      continue;
    }

    const manifestPrompt = findPrompt(loadPromptSource(path), prompt.id, prompt.version);
    if (manifestPrompt) {
      return manifestPrompt;
    }
  }

  if (manifestRequired) {
    const versionSuffix = prompt.version ? ` version ${JSON.stringify(prompt.version)}` : '';
    throw new ConfigurationError(
      `Prompt ${JSON.stringify(prompt.id)}${versionSuffix} was not found in the bundled ` +
        'prompt files. Production prompts must be committed to Git and included in ' +
        'the deploy artifact.',
    );
  }

  return null;
}

function hasExplicitManifestSource(): boolean {
  return Boolean(process.env.AGNT5_PROMPT_OVERRIDE || process.env.AGNT5_PROMPTS_MANIFEST);
}

function isProductionPrompt(prompt: Prompt): boolean {
  const candidates = [
    prompt.environmentRef,
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
  if (isExplicitPromptFile(source)) {
    return [source];
  }
  const extension = extname(source).toLowerCase();
  if (extension) {
    throw new ConfigurationError(`Prompt source ${source} must be a .md or .mdx file`);
  }
  return [
    `${source}/${DEFAULT_PROMPT_DIR}/${promptId}.mdx`,
    `${source}/${DEFAULT_PROMPT_DIR}/${promptId}.md`,
    `${source}/${promptId}.mdx`,
    `${source}/${promptId}.md`,
  ];
}

function isExplicitPromptFile(source: string): boolean {
  return [...MDX_PROMPT_EXTENSIONS].some((extension) => source.endsWith(extension));
}

function loadPromptSource(path: string): unknown {
  if (!isMdxPromptPath(path)) {
    throw new ConfigurationError(`Prompt source ${path} must be a .md or .mdx file`);
  }
  return loadMdxPrompt(path);
}

function isMdxPromptPath(path: string): boolean {
  return [...MDX_PROMPT_EXTENSIONS].some((extension) => path.toLowerCase().endsWith(extension));
}

function loadMdxPrompt(path: string): ManifestPrompt {
  const source = readFileSync(path, 'utf8');
  const { frontmatter, body } = splitMdxFrontmatter(source, path);
  return {
    id: path.split('/').pop()?.replace(/\.(?:mdx|md)$/i, ''),
    ...normalizeMdxPrompt(parseFrontmatter(frontmatter, path)),
    messages: parseMdxMessages(body),
  };
}

function splitMdxFrontmatter(source: string, path: string): { frontmatter: string; body: string } {
  const lines = source.split(/\r?\n/);
  if (!lines.length || lines[0]?.trim() !== '---') {
    throw new ConfigurationError(`Prompt MDX at ${path} is missing front matter`);
  }

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '---') {
      return {
        frontmatter: lines.slice(1, index).join('\n'),
        body: lines.slice(index + 1).join('\n'),
      };
    }
  }

  throw new ConfigurationError(`Prompt MDX at ${path} has unterminated front matter`);
}

function parseFrontmatter(source: string, path: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const lines = source.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const rawLine = lines[index] ?? '';
    const stripped = rawLine.trim();
    index += 1;
    if (!stripped || stripped.startsWith('#')) {
      continue;
    }
    if (!stripped.includes(':')) {
      throw new ConfigurationError(`Invalid front matter line in ${path}: ${rawLine}`);
    }

    const separator = stripped.indexOf(':');
    const key = stripped.slice(0, separator).trim();
    const value = stripped.slice(separator + 1).trim();
    if (value) {
      data[key] = parseFrontmatterValue(value);
      continue;
    }

    const items: unknown[] = [];
    while (index < lines.length) {
      const itemLine = lines[index] ?? '';
      const item = itemLine.trim();
      if (!item) {
        index += 1;
        continue;
      }
      if (!/^\s/.test(itemLine)) {
        break;
      }
      if (!item.startsWith('- ')) {
        throw new ConfigurationError(
          `Unsupported nested front matter for ${JSON.stringify(key)} in ${path}; use an inline JSON value instead`,
        );
      }
      items.push(parseFrontmatterValue(item.slice(2).trim()));
      index += 1;
    }
    data[key] = items;
  }
  return data;
}

function parseFrontmatterValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.startsWith('"') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.replace(/^"|"$/g, '');
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }

  const lowered = trimmed.toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;
  if (lowered === 'null' || lowered === 'none') return null;
  if (/^[-+]?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^[-+]?(?:\d+\.\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(trimmed) || /^[-+]?\d+e[-+]?\d+$/i.test(trimmed)) {
    return Number.parseFloat(trimmed);
  }
  return trimmed;
}

function normalizeMdxPrompt(frontmatter: Record<string, unknown>): ManifestPrompt {
  const prompt: ManifestPrompt = { ...frontmatter };
  const existingParameters =
    prompt.parameters && typeof prompt.parameters === 'object' && !Array.isArray(prompt.parameters)
      ? prompt.parameters
      : {};
  const parameters: Record<string, unknown> = { ...existingParameters };

  for (const key of FRONTMATTER_PARAMETER_KEYS) {
    if (key in prompt) {
      const parameterKey = key === 'max_output_tokens' ? 'max_tokens' : key;
      parameters[parameterKey] = (prompt as Record<string, unknown>)[key];
      delete (prompt as Record<string, unknown>)[key];
    }
  }

  if (Object.keys(parameters).length > 0) {
    prompt.parameters = parameters;
  }
  if (prompt.response_schema_json && !prompt.response_schema) {
    prompt.response_schema = parseJsonFrontmatterField(
      prompt.response_schema_json,
      'response_schema_json',
    ) as Record<string, unknown>;
    delete prompt.response_schema_json;
  }
  if (prompt.tools_json && !prompt.tools) {
    prompt.tools = parseJsonFrontmatterField(prompt.tools_json, 'tools_json') as unknown[];
    delete prompt.tools_json;
  }

  return prompt;
}

function parseJsonFrontmatterField(value: unknown, field: string): unknown {
  if (value && typeof value === 'object') {
    return value;
  }
  if (typeof value !== 'string') {
    throw new ConfigurationError(`Prompt MDX front matter field ${JSON.stringify(field)} must be JSON`);
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new ConfigurationError(`Invalid JSON in prompt MDX front matter field ${JSON.stringify(field)}: ${String(error)}`);
  }
}

function parseMdxMessages(body: string): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  for (const match of body.matchAll(MDX_ROLE_BLOCK_RE)) {
    const content = (match[2] ?? '').trim();
    if (content) {
      messages.push({ role: String(match[1]).toLowerCase(), content });
    }
  }

  if (messages.length > 0) {
    return messages;
  }

  const content = body.trim();
  return content ? [{ role: 'user', content }] : [];
}

function findPrompt(data: unknown, promptId: string, version?: string): ManifestPrompt | null {
  for (const prompt of iterPrompts(data)) {
    const candidateId = String(prompt.id ?? prompt.public_id ?? '');
    if (candidateId !== promptId) {
      continue;
    }
    if (version !== undefined) {
      const candidateVersion = String(prompt.version ?? '');
      const candidateVersionId = String(prompt.version_id ?? '');
      if (candidateVersion !== String(version) && candidateVersionId !== String(version)) {
        continue;
      }
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
