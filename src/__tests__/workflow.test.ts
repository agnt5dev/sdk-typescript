import { describe, it, expect, beforeEach } from 'vitest';
import { workflow, WorkflowRegistry } from '../workflow.js';
import { ContextImpl } from '../context.js';

describe('Workflow', () => {
  beforeEach(() => {
    WorkflowRegistry.clear();
  });

  it('should create and register a workflow', () => {
    const myWorkflow = workflow('test_workflow', async (ctx, input: string) => {
      return `Processed: ${input}`;
    });

    expect(WorkflowRegistry.listNames()).toContain('test_workflow');
    const registered = WorkflowRegistry.get('test_workflow');
    expect(registered).toBeDefined();
    expect(registered?.name).toBe('test_workflow');
  });

  it('should execute workflow with context', async () => {
    const processData = workflow('process_data', async (ctx, data: string) => {
      const step1 = await ctx.step('step1', async () => data.toUpperCase());
      const step2 = await ctx.step('step2', async () => step1 + '!!!');
      return step2;
    });

    const ctx = new ContextImpl('inv-1', 'run-1', 0, 'test');
    const result = await processData(ctx, 'hello');

    expect(result).toBe('HELLO!!!');
  });

  it('should auto-create context when called directly', async () => {
    const simpleWorkflow = workflow('simple', async (ctx, value: number) => {
      return value * 2;
    });

    const result = await simpleWorkflow(10);
    expect(result).toBe(20);
  });

  it('should support checkpointing across steps', async () => {
    let executionCount = 0;

    const checkpointWorkflow = workflow('checkpoint_test', async (ctx, input: number) => {
      const step1 = await ctx.step('expensive_step', async () => {
        executionCount++;
        return input * 2;
      });

      const step2 = await ctx.step('another_step', async () => {
        return step1 + 10;
      });

      return step2;
    });

    // Use in-memory storage to avoid stale SQLite checkpoints
    const ctx = new ContextImpl('inv-1', 'run-1', 0, 'test', { storage: 'memory' });

    // First execution
    const result1 = await checkpointWorkflow(ctx, 5);
    expect(result1).toBe(20);
    expect(executionCount).toBe(1);

    // Second execution with same context (should skip checkpointed step)
    const result2 = await checkpointWorkflow(ctx, 5);
    expect(result2).toBe(20);
    expect(executionCount).toBe(1); // Should still be 1 (not re-executed)
  });

  it('should handle workflow errors', async () => {
    const errorWorkflow = workflow('error_workflow', async (ctx, input: string) => {
      await ctx.step('failing_step', async () => {
        throw new Error('Step failed');
      });
      return 'should not reach here';
    });

    const ctx = new ContextImpl('inv-1', 'run-1', 0, 'test');
    await expect(errorWorkflow(ctx, 'test')).rejects.toThrow('Step failed');
  });

  it('should support multi-step orchestration', async () => {
    const orderWorkflow = workflow('process_order', async (ctx, orderId: string) => {
      const validated = await ctx.step('validate', async () => {
        return { orderId, valid: true };
      });

      const payment = await ctx.step('payment', async () => {
        return { status: 'success', amount: 100 };
      });

      const fulfillment = await ctx.step('fulfill', async () => {
        return { status: 'shipped', trackingId: 'track-123' };
      });

      return {
        orderId: validated.orderId,
        paymentStatus: payment.status,
        fulfillmentStatus: fulfillment.status,
        total: payment.amount
      };
    });

    const ctx = new ContextImpl('inv-1', 'run-1', 0, 'test');
    const result = await orderWorkflow(ctx, 'order-123');

    expect(result.orderId).toBe('order-123');
    expect(result.paymentStatus).toBe('success');
    expect(result.fulfillmentStatus).toBe('shipped');
    expect(result.total).toBe(100);
  });
});
