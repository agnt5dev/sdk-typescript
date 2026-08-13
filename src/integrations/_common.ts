import type { Context } from '../types.js';
import {
  generateCid,
  lmCompleted,
  lmFailed,
  lmStarted,
  type BaseEvent,
  type LMCompleted,
  type LMFailed,
  type LMStarted,
} from '../events.js';
import { getCurrentContext } from '../async-context.js';

export const SOURCE_METADATA_KEY = 'source';
export const CAPTURE_MODE_METADATA_KEY = 'capture_mode';
export const OBSERVED_CAPTURE_MODE = 'observed' as const;

const OFF_VALUES = new Set(['off', '0', 'false', 'no']);

export function masterCaptureEnabled(): boolean {
  return !OFF_VALUES.has((process.env.AGNT5_CAPTURE ?? '').trim().toLowerCase());
}

export function libraryCaptureEnabled(flag: string): boolean {
  return !OFF_VALUES.has((process.env[flag] ?? '').trim().toLowerCase());
}

export function contentCaptureEnabled(): boolean {
  return !OFF_VALUES.has((process.env.AGNT5_LLM_CAPTURE_CONTENT ?? '').trim().toLowerCase());
}

/** The live component context for the current worker execution, if any. */
export function ambientContext(): Context | undefined {
  try {
    return getCurrentContext()?.executionContext;
  } catch {
    return undefined;
  }
}

export interface CaptureSpan {
  ctx: Context;
  correlationId: string;
  parentCorrelationId: string;
  startedAtMs: number;
}

/** Allocate a child correlation id and snapshot its parent before any await. */
export function newCaptureSpan(ctx: Context): CaptureSpan {
  const parent = (ctx as Context & { getCurrentCorrelationId?: () => string | undefined })
    .getCurrentCorrelationId?.();
  return {
    ctx,
    correlationId: generateCid(),
    parentCorrelationId: parent ?? ctx.runId.slice(0, 8),
    startedAtMs: performance.now(),
  };
}

export function elapsedMs(span: Pick<CaptureSpan, 'startedAtMs'>): number {
  return Math.max(0, Math.round(performance.now() - span.startedAtMs));
}

/** Best-effort emission that can never reject into third-party user code. */
export async function safeEmit(ctx: Context, event: BaseEvent): Promise<void> {
  try {
    await ctx.emit(event);
  } catch (error) {
    debugLog('capture emit failed', error);
  }
}

export function debugLog(message: string, error?: unknown): void {
  if (!process.env.AGNT5_DEBUG) return;
  const suffix = error instanceof Error ? `: ${error.message}` : error ? `: ${String(error)}` : '';
  console.debug(`[agnt5 capture] ${message}${suffix}`);
}

export function prefixedModel(provider: string, model: unknown): string {
  const value = typeof model === 'string' ? model : model == null ? '' : String(model);
  if (!value) return provider;
  return value.startsWith(`${provider}/`) ? value : `${provider}/${value}`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? error);
  }
  return String(error);
}

export function errorCode(error: unknown): string {
  return error instanceof Error ? error.name || 'Error' : 'Error';
}

export interface LMStartedFields {
  source: string;
  model: string;
  provider: string;
  correlationId: string;
  parentCorrelationId: string;
  messages?: unknown[];
  systemPrompt?: string;
  toolsCount?: number;
  temperature?: number;
  maxTokens?: number | null;
}

export function buildLMStarted(fields: LMStartedFields): LMStarted {
  return lmStarted(fields.correlationId, fields.parentCorrelationId, {
    model: fields.model,
    provider: fields.provider,
    messages: fields.messages ?? [],
    systemPrompt: fields.systemPrompt,
    toolsCount: fields.toolsCount ?? 0,
    temperature: fields.temperature,
    maxTokens: fields.maxTokens,
    source: fields.source,
    captureMode: OBSERVED_CAPTURE_MODE,
  });
}

export interface LMCompletedFields {
  source: string;
  model: string;
  provider: string;
  correlationId: string;
  parentCorrelationId: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  finishReason?: string;
  output?: string;
  toolCalls?: unknown;
}

export function buildLMCompleted(fields: LMCompletedFields): LMCompleted {
  const inputTokens = integer(fields.inputTokens);
  const outputTokens = integer(fields.outputTokens);
  return lmCompleted(fields.correlationId, fields.parentCorrelationId, {
    model: fields.model,
    provider: fields.provider,
    output: fields.output ?? '',
    toolCalls: fields.toolCalls,
    inputTokens,
    outputTokens,
    totalTokens: integer(fields.totalTokens) || inputTokens + outputTokens,
    cachedTokens: integer(fields.cachedTokens),
    durationMs: integer(fields.durationMs),
    finishReason: fields.finishReason,
    source: fields.source,
    captureMode: OBSERVED_CAPTURE_MODE,
  });
}

export interface LMFailedFields {
  source: string;
  model: string;
  provider: string;
  correlationId: string;
  parentCorrelationId: string;
  durationMs: number;
  error: unknown;
}

export function buildLMFailed(fields: LMFailedFields): LMFailed {
  return lmFailed(fields.correlationId, fields.parentCorrelationId, {
    model: fields.model,
    provider: fields.provider,
    errorCode: errorCode(fields.error),
    errorMessage: errorMessage(fields.error),
    durationMs: integer(fields.durationMs),
    source: fields.source,
    captureMode: OBSERVED_CAPTURE_MODE,
  });
}

export function integer(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

export function valueAt(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function stringValue(value: unknown): string | undefined {
  return value == null || value === '' ? undefined : String(value);
}

export function jsonString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
