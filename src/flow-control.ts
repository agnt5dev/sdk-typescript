/**
 * Declarative run admission and scheduling policy carried in workerless
 * manifests. The runtime owns enforcement; SDKs only emit the immutable
 * declaration so Cloudflare, Vercel, and generic Node.js hosts share one
 * contract.
 */

export type WorkerlessFlowControlPriority = 'interactive' | 'normal' | 'batch';
export type WorkerlessFlowControlScope = 'project' | 'deployment' | 'component' | 'workspace' | 'custom';
export type WorkerlessBackoffType = 'constant' | 'linear' | 'exponential';

export interface WorkerlessRetryPolicy {
  maxAttempts?: number;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  backoff?: WorkerlessBackoffType;
  multiplier?: number;
}

export interface WorkerlessConcurrencyPolicy {
  limit: number;
  scope?: WorkerlessFlowControlScope;
  key?: string;
  keyExpression?: string;
}

export interface WorkerlessWindowPolicy {
  limit: number;
  periodMs?: number;
  windowMs?: number;
  key?: string;
  keyExpression?: string;
}

export interface WorkerlessDebouncePolicy {
  windowMs: number;
  key?: string;
  keyExpression?: string;
}

export interface WorkerlessBatchPolicy {
  maxSize?: number;
  windowMs?: number;
  key?: string;
  keyExpression?: string;
}

export interface WorkerlessPriorityPolicy {
  level?: WorkerlessFlowControlPriority;
  expression?: string;
}

export interface WorkerlessSingletonPolicy {
  key?: string;
  keyExpression?: string;
  mode?: 'queue';
}

export interface WorkerlessIdempotencyPolicy {
  key?: string;
  keyExpression?: string;
  ttlMs?: number;
}

export interface WorkerlessFlowControlPolicy {
  retries?: WorkerlessRetryPolicy;
  concurrency?: WorkerlessConcurrencyPolicy;
  /** Sliding-window dispatch throttle enforced by the workerless beta runtime. */
  throttle?: WorkerlessWindowPolicy;
  /** Sliding-window rate limit enforced by the workerless beta runtime. */
  rateLimit?: WorkerlessWindowPolicy;
  /** Manifest-shaped alias for the workerless beta runtime rate limit. */
  rate_limit?: WorkerlessWindowPolicy;
  /** Latest-run-wins quiet-window debounce enforced by the workerless beta runtime. */
  debounce?: WorkerlessDebouncePolicy;
  /** Future scheduler policy. Workerless beta registration rejects this until runtime enforcement exists. */
  batch?: WorkerlessBatchPolicy;
  priority?: WorkerlessFlowControlPriority | WorkerlessPriorityPolicy | number;
  singleton?: WorkerlessSingletonPolicy;
  idempotency?: WorkerlessIdempotencyPolicy;
}
