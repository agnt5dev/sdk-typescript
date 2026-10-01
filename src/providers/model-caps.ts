import { isOpenAIReasoningModel } from './openai-models.js';

/**
 * What a model accepts, decided from its id. Mirrors `lm::model_caps` in
 * sdk-core, for the paths that don't go through it (edge provider, Agent
 * defaults).
 */

const CLAUDE_FAMILIES = new Set(['opus', 'sonnet', 'haiku', 'instant']);

/** Strip `provider/`, Bedrock region/vendor prefixes, `@version` and `-v1:0`. */
function bareModel(model: string): string {
  let name = model.trim().toLowerCase();
  name = name.slice(name.lastIndexOf('/') + 1);
  const vendor = name.indexOf('anthropic.');
  if (vendor >= 0) name = name.slice(vendor + 'anthropic.'.length);
  name = name.split('@')[0];
  return name.replace(/-v\d+:\d+$/, '');
}

/**
 * Claude models that reject `temperature` and `top_p` with a 400: everything
 * after Opus 4.6 / Sonnet 4.6 / Haiku 4.5 (the cutoff is per family),
 * including Fable. New or
 * unrecognised Claude models count as rejecting, since dropping a sampling
 * parameter degrades quietly while sending one fails the call (AGNT5-1403).
 */
export function claudeRejectsSamplingParams(model: string): boolean {
  const name = bareModel(model);
  if (!name.startsWith('claude-')) return false;

  const version: number[] = [];
  let family: string | undefined;
  for (const token of name.slice('claude-'.length).split(/[-.]/)) {
    if (/^\d{1,2}$/.test(token)) {
      version.push(Number(token));
      continue;
    }
    if (version.length === 0 && !CLAUDE_FAMILIES.has(token)) return true;
    if (version.length > 0) break;
    family = token;
  }

  if (version.length === 0) return true;
  // Newest accepting version per family: Haiku 4.5, Opus/Sonnet 4.6.
  // Version-first ids (claude-3-5-haiku) are all 3.x or older.
  const lastMinor = family === 'haiku' ? 5 : 6;
  const minor = version[1] ?? 0;
  return version[0] > 4 || (version[0] === 4 && minor > lastMinor);
}

/** Default output budget for a Claude model; thinking counts toward it. */
export function claudeDefaultMaxTokens(model: string): number {
  return claudeRejectsSamplingParams(model) ? 16_384 : 4_096;
}

/** Whether `model` rejects `temperature`/`top_p` (OpenAI reasoning models, new Claude). */
export function rejectsSamplingParams(model: string): boolean {
  return isOpenAIReasoningModel(bareModel(model)) || claudeRejectsSamplingParams(model);
}
