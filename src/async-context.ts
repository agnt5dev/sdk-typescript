/**
 * Context propagation via Node.js AsyncLocalStorage.
 *
 * Provides implicit context propagation through async call chains
 * without threading context through every function parameter.
 *
 * Usage:
 *   // In worker dispatch or middleware:
 *   runWithContext({ runId, sessionId, userId, correlationId }, async () => {
 *     // Deep inside a function/agent/workflow:
 *     const ctx = getCurrentContext();
 *     console.log(ctx?.runId);
 *   });
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { RuntimeContext } from './runtime-context.js';

/**
 * Propagated context data available throughout an async execution chain.
 */
export interface PropagatedContext {
  /** Current run ID */
  runId: string;
  /** Session ID for multi-turn conversations */
  sessionId?: string;
  /** User ID for user-scoped operations */
  userId?: string;
  /** Correlation ID for distributed tracing */
  correlationId?: string;
  /** Tenant ID for multi-tenant deployments */
  tenantId?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, any>;
  /** Runtime-provided execution options */
  runtime?: RuntimeContext;
  /**
   * Active event emitter for the run. Set by the worker after dispatch so that
   * module-level loggers (getLogger / ContextLogger) can emit `log.*` journal
   * events tied to the current run — the Studio Logs panel is populated from
   * these (AGNT5-569). Typed loosely to avoid an import cycle with event-emitter.
   */
  emitter?: { emit: (event: any) => Promise<void> | void };
  /** Returns the innermost active correlation id, for nesting log events. */
  getCorrelationId?: () => string | undefined;
}

const asyncLocalStorage = new AsyncLocalStorage<PropagatedContext>();

/**
 * Run a function with propagated context.
 * All async operations within the callback can access this context
 * via getCurrentContext().
 *
 * @example
 * ```typescript
 * await runWithContext(
 *   { runId: 'run-1', sessionId: 'sess-1', userId: 'user-42' },
 *   async () => {
 *     const ctx = getCurrentContext();
 *     console.log(ctx?.runId); // 'run-1'
 *   },
 * );
 * ```
 */
export function runWithContext<T>(
  context: PropagatedContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return asyncLocalStorage.run(context, fn);
}

/**
 * Get the current propagated context, or undefined if not within a context scope.
 */
export function getCurrentContext(): PropagatedContext | undefined {
  return asyncLocalStorage.getStore();
}

/**
 * Get the current propagated context, throwing if not within a context scope.
 */
export function requireContext(): PropagatedContext {
  const ctx = asyncLocalStorage.getStore();
  if (!ctx) {
    throw new Error(
      'No propagated context available. Ensure this code runs inside runWithContext().',
    );
  }
  return ctx;
}
