/**
 * Batch execution types for running components with multiple inputs.
 */

/**
 * Configuration for batch execution.
 */
export interface BatchConfig {
  /** Maximum concurrent executions (default: 10) */
  maxConcurrency?: number;
  /** Continue executing remaining items after a failure (default: true) */
  continueOnFailure?: boolean;
  /** Overall batch timeout in milliseconds (default: 3600000 = 1 hour) */
  batchTimeoutMs?: number;
  /** Default per-item timeout in milliseconds (default: 30000 = 30s) */
  defaultItemTimeoutMs?: number;
}

/**
 * Input for a single batch item.
 */
export interface BatchItemInput {
  /** Input data for the component */
  input: Record<string, any>;
  /** Optional item index (auto-assigned if omitted) */
  index?: number;
  /** Optional unique item identifier */
  itemId?: string;
  /** Optional per-item metadata */
  metadata?: Record<string, string>;
  /** Override timeout for this item in milliseconds */
  timeoutMs?: number;
}

/**
 * Error detail for a failed batch item.
 */
export interface BatchItemError {
  code?: string;
  message?: string;
}

/**
 * Result of a single batch item execution.
 */
export interface BatchItemResult {
  index: number;
  runId: string;
  status: 'completed' | 'failed' | 'cancelled';
  itemId?: string;
  output?: any;
  error?: BatchItemError;
  durationMs?: number;
  startedAt?: string;
  completedAt?: string;
}

/**
 * Aggregate statistics for a batch execution.
 */
export interface BatchStats {
  totalItems: number;
  completedItems: number;
  failedItems: number;
  cancelledItems: number;
  pendingItems: number;
  durationMs: number;
  avgItemDurationMs: number;
}

/** Batch execution status */
export type BatchStatus = 'completed' | 'partial_failure' | 'failed' | 'cancelled' | 'pending' | 'queued' | 'running';

/**
 * Result of a batch execution.
 */
export class BatchResult {
  readonly batchId: string;
  readonly status: BatchStatus;
  readonly results: BatchItemResult[];
  readonly stats: BatchStats | undefined;
  readonly traceId: string | undefined;
  readonly createdAt: string | undefined;

  constructor(raw: Record<string, any>) {
    this.batchId = raw.batch_id || raw.batchId || '';
    this.status = (raw.status as BatchStatus) || 'completed';
    this.traceId = raw.trace_id || raw.traceId;
    this.createdAt = raw.created_at || raw.createdAt;
    this.results = (raw.results || []).map((r: any) => ({
      index: r.index ?? 0,
      runId: r.run_id || r.runId || '',
      status: r.status || 'failed',
      itemId: r.item_id || r.itemId,
      output: r.output,
      error: r.error ? { code: r.error.code, message: r.error.message || String(r.error) } : undefined,
      durationMs: r.duration_ms || r.durationMs,
      startedAt: r.started_at || r.startedAt,
      completedAt: r.completed_at || r.completedAt,
    }));
    this.stats = raw.stats ? {
      totalItems: raw.stats.total_items ?? raw.stats.totalItems ?? 0,
      completedItems: raw.stats.completed_items ?? raw.stats.completedItems ?? 0,
      failedItems: raw.stats.failed_items ?? raw.stats.failedItems ?? 0,
      cancelledItems: raw.stats.cancelled_items ?? raw.stats.cancelledItems ?? 0,
      pendingItems: raw.stats.pending_items ?? raw.stats.pendingItems ?? 0,
      durationMs: raw.stats.duration_ms ?? raw.stats.durationMs ?? 0,
      avgItemDurationMs: raw.stats.avg_item_duration_ms ?? raw.stats.avgItemDurationMs ?? 0,
    } : undefined;
  }

  /** True if all items completed successfully */
  get isSuccess(): boolean {
    return this.status === 'completed';
  }

  /** True if some items failed but others succeeded */
  get isPartialFailure(): boolean {
    return this.status === 'partial_failure';
  }

  /** Get outputs from all items sorted by index (failed items return undefined) */
  get outputs(): (any | undefined)[] {
    return [...this.results]
      .sort((a, b) => a.index - b.index)
      .map(r => r.output);
  }

  /** Get outputs only from successfully completed items */
  successfulOutputs(): any[] {
    return this.results.filter(r => r.status === 'completed').map(r => r.output);
  }

  /** Get items that failed */
  failedItems(): BatchItemResult[] {
    return this.results.filter(r => r.status === 'failed');
  }
}

/**
 * Result of a batch status query.
 */
export class BatchStatusResult {
  readonly batchId: string;
  readonly status: BatchStatus;
  readonly results: BatchItemResult[];
  readonly stats: BatchStats | undefined;
  readonly traceId: string | undefined;
  readonly submittedAt: string | undefined;
  readonly startedAt: string | undefined;
  readonly completedAt: string | undefined;

  constructor(raw: Record<string, any>) {
    this.batchId = raw.batch_id || raw.batchId || '';
    this.status = (raw.status as BatchStatus) || 'pending';
    this.traceId = raw.trace_id || raw.traceId;
    this.submittedAt = raw.submitted_at || raw.submittedAt;
    this.startedAt = raw.started_at || raw.startedAt;
    this.completedAt = raw.completed_at || raw.completedAt;
    this.results = (raw.results || []).map((r: any) => ({
      index: r.index ?? 0,
      runId: r.run_id || r.runId || '',
      status: r.status || 'failed',
      itemId: r.item_id || r.itemId,
      output: r.output,
      error: r.error ? { code: r.error.code, message: r.error.message || String(r.error) } : undefined,
      durationMs: r.duration_ms || r.durationMs,
      startedAt: r.started_at || r.startedAt,
      completedAt: r.completed_at || r.completedAt,
    }));
    this.stats = raw.stats ? {
      totalItems: raw.stats.total_items ?? raw.stats.totalItems ?? 0,
      completedItems: raw.stats.completed_items ?? raw.stats.completedItems ?? 0,
      failedItems: raw.stats.failed_items ?? raw.stats.failedItems ?? 0,
      cancelledItems: raw.stats.cancelled_items ?? raw.stats.cancelledItems ?? 0,
      pendingItems: raw.stats.pending_items ?? raw.stats.pendingItems ?? 0,
      durationMs: raw.stats.duration_ms ?? raw.stats.durationMs ?? 0,
      avgItemDurationMs: raw.stats.avg_item_duration_ms ?? raw.stats.avgItemDurationMs ?? 0,
    } : undefined;
  }

  /** True if batch is still running */
  get isRunning(): boolean {
    return ['pending', 'queued', 'running'].includes(this.status);
  }

  /** True if batch has completed (successfully or with failures) */
  get isCompleted(): boolean {
    return ['completed', 'partial_failure', 'failed', 'cancelled'].includes(this.status);
  }
}

/**
 * Result of cancelling a batch.
 */
export interface CancelBatchResult {
  batchId: string;
  status: string;
  cancelledItems: number;
  completedItems: number;
}
