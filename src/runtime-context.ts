export interface LLMRuntimeOptions {
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
}

export interface RuntimeContext {
  llm: LLMRuntimeOptions;
  prompts: Record<string, LLMRuntimeOptions>;
}

export function emptyRuntimeContext(): RuntimeContext {
  return { llm: {}, prompts: {} };
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export function runtimeContextFromMetadata(
  metadata?: Record<string, unknown>,
): RuntimeContext {
  const runtime = emptyRuntimeContext();
  if (!metadata) return runtime;

  const llmData: Record<string, unknown> = {};
  const rawLLM = metadata['agnt5.llm'];
  if (typeof rawLLM === 'string' && rawLLM.trim()) {
    try {
      const parsed = JSON.parse(rawLLM);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.assign(llmData, parsed);
      }
    } catch {
      // Ignore malformed runtime override metadata.
    }
  } else if (rawLLM && typeof rawLLM === 'object' && !Array.isArray(rawLLM)) {
    Object.assign(llmData, rawLLM);
  }

  const flatKeys: Record<string, string> = {
    model: 'agnt5.llm.model',
    temperature: 'agnt5.llm.temperature',
    maxOutputTokens: 'agnt5.llm.max_output_tokens',
    topP: 'agnt5.llm.top_p',
  };
  for (const [target, key] of Object.entries(flatKeys)) {
    if (metadata[key] !== undefined) {
      llmData[target] = metadata[key];
    }
  }
  if (metadata['agnt5.llm.max_tokens'] !== undefined) {
    llmData.maxOutputTokens = metadata['agnt5.llm.max_tokens'];
  }

  runtime.llm = {
    model: llmData.model ? String(llmData.model).trim() : undefined,
    temperature: optionalNumber(llmData.temperature),
    maxOutputTokens: optionalNumber(llmData.maxOutputTokens ?? llmData.max_tokens),
    topP: optionalNumber(llmData.topP ?? llmData.top_p),
  };

  const rawPrompts = metadata['agnt5.prompts'];
  const promptsData: Record<string, unknown> = {};
  if (typeof rawPrompts === 'string' && rawPrompts.trim()) {
    try {
      const parsed = JSON.parse(rawPrompts);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.assign(promptsData, parsed);
      }
    } catch {
      // Ignore malformed prompt-specific runtime override metadata.
    }
  } else if (rawPrompts && typeof rawPrompts === 'object' && !Array.isArray(rawPrompts)) {
    Object.assign(promptsData, rawPrompts);
  }

  for (const [promptId, promptData] of Object.entries(promptsData)) {
    if (!promptData || typeof promptData !== 'object' || Array.isArray(promptData)) {
      continue;
    }
    const promptRecord = promptData as Record<string, unknown>;
    const rawPromptLLM = promptRecord.llm ?? promptRecord;
    if (!rawPromptLLM || typeof rawPromptLLM !== 'object' || Array.isArray(rawPromptLLM)) {
      continue;
    }
    const promptLLM = rawPromptLLM as Record<string, unknown>;
    runtime.prompts[promptId] = {
      model: promptLLM.model ? String(promptLLM.model).trim() : undefined,
      temperature: optionalNumber(promptLLM.temperature),
      maxOutputTokens: optionalNumber(promptLLM.maxOutputTokens ?? promptLLM.max_tokens),
      topP: optionalNumber(promptLLM.topP ?? promptLLM.top_p),
    };
  }
  return runtime;
}
