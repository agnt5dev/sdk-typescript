/**
 * Example: Context propagation across components
 *
 * Demonstrates how context (session, user, correlation IDs) flows
 * through component hierarchies using AsyncLocalStorage.
 */

import { fn, workflow, runWithContext, getCurrentContext, requireContext } from '../src/index.js';
import type { Context } from '../src/types.js';

// ─── 1. Define components that read context ─────────────────────────

const getUser = fn('get-user', {
  description: 'Get current user from propagated context',
  handler: async (ctx) => {
    const context = getCurrentContext();
    return {
      userId: context?.userId || 'anonymous',
      sessionId: context?.sessionId || 'none',
      correlationId: context?.correlationId || 'unknown',
    };
  },
});

const logAction = fn('log-action', {
  description: 'Log an action with context',
  handler: async (ctx, action: string) => {
    const context = requireContext(); // Throws if not in context scope
    console.log(`[${context.correlationId}] User ${context.userId}: ${action}`);
    return { logged: true };
  },
});

// ─── 2. Workflow that depends on context ────────────────────────────

const auditedWorkflow = workflow('audited-pipeline', {
  description: 'Workflow that uses propagated context for audit trail',
  handler: async (ctx, input: { data: string }) => {
    const context = getCurrentContext();

    const results = {
      step1: await ctx.step('validate', async () => {
        console.log(`Validating as user: ${context?.userId}`);
        return { valid: true };
      }),
      step2: await ctx.step('process', async () => {
        console.log(`Processing with session: ${context?.sessionId}`);
        return { processed: input.data.toUpperCase() };
      }),
      step3: await ctx.step('audit', async () => {
        return {
          action: 'process_data',
          userId: context?.userId,
          sessionId: context?.sessionId,
          tenantId: context?.tenantId,
          timestamp: new Date().toISOString(),
        };
      }),
    };

    return results;
  },
});

// ─── 3. Manual context propagation ──────────────────────────────────

async function main() {
  console.log('=== Context propagation examples ===\n');

  // Outside any context
  console.log('No context:', getCurrentContext()); // undefined

  // Run with explicit context
  await runWithContext(
    {
      runId: 'run-001',
      sessionId: 'session-abc',
      userId: 'user-alice',
      correlationId: 'corr-xyz',
      tenantId: 'tenant-acme',
    },
    async () => {
      const ctx = getCurrentContext()!;
      console.log('Inside context:');
      console.log('  Run ID:', ctx.runId);
      console.log('  Session:', ctx.sessionId);
      console.log('  User:', ctx.userId);
      console.log('  Correlation:', ctx.correlationId);
      console.log('  Tenant:', ctx.tenantId);

      // Nested contexts inherit and can override
      await runWithContext(
        {
          runId: 'run-002',
          correlationId: 'corr-nested',
          // sessionId and userId inherited? No - each context is independent
        },
        async () => {
          const nested = getCurrentContext()!;
          console.log('\nNested context:');
          console.log('  Run ID:', nested.runId);         // run-002
          console.log('  Correlation:', nested.correlationId); // corr-nested
        },
      );

      // After nested context, original is restored
      const restored = getCurrentContext()!;
      console.log('\nRestored context:');
      console.log('  Run ID:', restored.runId); // run-001
    },
  );

  // Back outside - no context
  console.log('\nAfter context:', getCurrentContext()); // undefined
}

main().catch(console.error);
