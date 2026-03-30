/**
 * Platform adapter interfaces for connecting TypeScript SDK features
 * to the Rust core via NAPI bindings.
 *
 * These adapters provide the TypeScript-side contract. When the Rust/NAPI
 * bindings expose PollJobs, CompleteJob, platform state, and real OTel spans,
 * these adapters will bridge to them.
 *
 * For now, each adapter has a stub/noop implementation that logs warnings.
 */

import type { StateAdapter } from './state.js';

// ─── Job Queue Adapter ───────────────────────────────────────────────

/** A job assignment from the platform queue */
export interface JobAssignment {
  jobId: string;
  runId: string;
  componentId: string;
  componentType: string;
  componentName: string;
  inputJson: string;
  metadata: Record<string, string>;
}

/** Result of completing a job */
export interface JobCompletionResult {
  acknowledged: boolean;
}

/**
 * Adapter for platform job queue polling.
 *
 * The platform implementation will call PollJobs/CompleteJob RPCs
 * via the NAPI-exposed Rust WorkerCoordinatorClient.
 */
export interface JobQueueAdapter {
  pollJobs(workerId: string, componentIds: string[], maxJobs: number): Promise<JobAssignment[]>;
  completeJob(
    jobId: string,
    success: boolean,
    outputJson?: string,
    errorMessage?: string,
    errorCode?: string,
    metadata?: Record<string, string>,
  ): Promise<JobCompletionResult>;
}

/**
 * Stub job queue adapter that always returns no jobs.
 * Used when NAPI bindings aren't available yet.
 */
export class StubJobQueueAdapter implements JobQueueAdapter {
  private warned = false;

  async pollJobs(): Promise<JobAssignment[]> {
    if (!this.warned) {
      console.warn('[agnt5] Job queue polling requires NAPI bindings (Phase D1). Using stub adapter.');
      this.warned = true;
    }
    return [];
  }

  async completeJob(): Promise<JobCompletionResult> {
    return { acknowledged: false };
  }
}

// ─── Platform State Adapter ──────────────────────────────────────────

/**
 * Platform-backed state adapter that persists state via the Rust core.
 *
 * When connected, state operations flow through NAPI → Rust core → gRPC
 * to the platform's state service.
 *
 * TODO(D1): Replace StubPlatformStateAdapter with actual NAPI bridge.
 */
export class StubPlatformStateAdapter implements StateAdapter {
  private warned = false;

  private warn(): void {
    if (!this.warned) {
      console.warn('[agnt5] Platform state adapter requires NAPI bindings (Phase D1). State is not persisted.');
      this.warned = true;
    }
  }

  async load(): Promise<Record<string, any> | null> {
    this.warn();
    return null;
  }

  async save(): Promise<void> {
    this.warn();
  }
}

// ─── Platform Tracing Adapter ────────────────────────────────────────

/** Attributes for a platform span */
export interface SpanAttributes {
  [key: string]: string | number | boolean;
}

/**
 * Adapter for platform-backed OpenTelemetry spans.
 *
 * The platform implementation will create real OTel spans via the
 * Rust core's telemetry subsystem, and export them to the journal.
 */
export interface PlatformSpanAdapter {
  createSpan(name: string, attributes?: SpanAttributes): PlatformSpanHandle;
}

/**
 * Handle to a platform span. Call end() when done.
 */
export interface PlatformSpanHandle {
  readonly traceId: string;
  readonly spanId: string;
  setAttribute(key: string, value: string | number | boolean): void;
  addEvent(name: string, attributes?: SpanAttributes): void;
  recordError(error: Error | string): void;
  end(): void;
}

/**
 * Stub span adapter that logs to console.
 * Used when NAPI bindings aren't available.
 */
export class StubPlatformSpanAdapter implements PlatformSpanAdapter {
  createSpan(name: string): PlatformSpanHandle {
    return {
      traceId: 'stub-trace',
      spanId: 'stub-span',
      setAttribute: () => {},
      addEvent: (eventName) => console.debug(`[span:${name}] event: ${eventName}`),
      recordError: (err) => console.error(`[span:${name}] error:`, err),
      end: () => {},
    };
  }
}

/**
 * NAPI-backed span adapter that creates real OpenTelemetry spans
 * via the sdk-core Rust telemetry subsystem.
 *
 * Uses the Span NAPI class from tracing.ts which delegates to
 * sdk-core's create_component_span() + OTLP exporter.
 */
export class NapiPlatformSpanAdapter implements PlatformSpanAdapter {
  createSpan(name: string, attributes?: SpanAttributes): PlatformSpanHandle {
    // Import Span from tracing.ts (which handles NAPI loading internally)
    // We use dynamic import to avoid circular deps at module load time
    const { Span } = require('./tracing.js');
    const stringAttrs: Record<string, string> = {};
    if (attributes) {
      for (const [k, v] of Object.entries(attributes)) {
        stringAttrs[k] = String(v);
      }
    }
    const span = new Span(name, 'platform', undefined, stringAttrs);
    return {
      get traceId() { return span.traceId; },
      get spanId() { return span.spanId; },
      setAttribute(key: string, value: string | number | boolean) {
        span.setAttribute(key, String(value));
      },
      addEvent(eventName: string, eventAttrs?: SpanAttributes) {
        // Span class delegates to NAPI addEvent if available
        span.setAttribute(`event.${eventName}`, 'true');
      },
      recordError(error: Error | string) {
        const msg = error instanceof Error ? error.message : error;
        span.recordException(new Error(msg));
      },
      end() {
        span.end();
      },
    };
  }
}

// ─── Job Queue Polling Loop ──────────────────────────────────────────

export interface JobQueueConfig {
  workerId: string;
  componentIds: string[];
  concurrency: number;
  pollIntervalMs: number;
  maxPollIntervalMs: number;
  adapter: JobQueueAdapter;
  handler: (job: JobAssignment) => Promise<{ outputJson?: string; error?: string }>;
}

/**
 * Run a job queue polling loop with capacity-aware exponential backoff.
 *
 * This is the TypeScript-side orchestration. The actual poll/complete RPCs
 * go through the JobQueueAdapter (NAPI when available, stub otherwise).
 *
 * @returns AbortController to stop polling
 */
export function startJobQueuePolling(config: JobQueueConfig): AbortController {
  const controller = new AbortController();
  const { adapter, handler, workerId, componentIds, concurrency } = config;
  let currentInterval = config.pollIntervalMs;
  let activeJobs = 0;

  const poll = async () => {
    if (controller.signal.aborted) return;

    const capacity = concurrency - activeJobs;
    if (capacity <= 0) {
      schedule();
      return;
    }

    try {
      const jobs = await adapter.pollJobs(workerId, componentIds, capacity);

      if (jobs.length > 0) {
        // Reset backoff on successful poll
        currentInterval = config.pollIntervalMs;

        for (const job of jobs) {
          activeJobs++;
          processJob(job).finally(() => {
            activeJobs--;
          });
        }
      } else {
        // Exponential backoff on empty poll
        currentInterval = Math.min(currentInterval * 2, config.maxPollIntervalMs);
      }
    } catch (error) {
      console.error('[agnt5] Job queue poll error:', error);
      currentInterval = Math.min(currentInterval * 2, config.maxPollIntervalMs);
    }

    schedule();
  };

  const processJob = async (job: JobAssignment) => {
    try {
      const result = await handler(job);
      await adapter.completeJob(
        job.jobId,
        !result.error,
        result.outputJson,
        result.error,
      );
    } catch (error) {
      await adapter.completeJob(
        job.jobId,
        false,
        undefined,
        (error as Error).message,
      );
    }
  };

  const schedule = () => {
    if (!controller.signal.aborted) {
      setTimeout(poll, currentInterval);
    }
  };

  // Start polling
  poll();

  return controller;
}
