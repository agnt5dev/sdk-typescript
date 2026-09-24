/**
 * OpenAI reasoning models — the gpt-5 and gpt-6 families and the o1/o3/o4
 * series — reject sampling parameters (`temperature`, `top_p`) and take
 * `max_completion_tokens` instead of `max_tokens`. gpt-4o and gpt-4.1 still
 * accept the classic parameters. One predicate for every caller, so a new
 * family is added in one place (AGNT5-1302).
 *
 * @param model The model name, with or without the `openai/` prefix.
 */
export function isOpenAIReasoningModel(model: string): boolean {
  const name = model.trim().toLowerCase().replace(/^openai\//, '');
  return name.startsWith('gpt-5') || name.startsWith('gpt-6') || /^(o1|o3|o4)(-|$)/.test(name);
}
