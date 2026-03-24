import { describe, it, expect } from 'vitest';
import { BatchResult, BatchStatusResult } from '../batch.js';

describe('BatchResult', () => {
  it('should parse a successful batch response', () => {
    const result = new BatchResult({
      batch_id: 'batch-1',
      status: 'completed',
      trace_id: 'trace-abc',
      results: [
        { index: 0, run_id: 'run-1', status: 'completed', output: 'hello', duration_ms: 100 },
        { index: 1, run_id: 'run-2', status: 'completed', output: 'world', duration_ms: 150 },
      ],
      stats: {
        total_items: 2,
        completed_items: 2,
        failed_items: 0,
        cancelled_items: 0,
        pending_items: 0,
        duration_ms: 250,
        avg_item_duration_ms: 125,
      },
    });

    expect(result.batchId).toBe('batch-1');
    expect(result.isSuccess).toBe(true);
    expect(result.isPartialFailure).toBe(false);
    expect(result.results).toHaveLength(2);
    expect(result.outputs).toEqual(['hello', 'world']);
    expect(result.stats?.totalItems).toBe(2);
    expect(result.stats?.avgItemDurationMs).toBe(125);
    expect(result.traceId).toBe('trace-abc');
  });

  it('should handle partial failure batch', () => {
    const result = new BatchResult({
      batch_id: 'batch-2',
      status: 'partial_failure',
      results: [
        { index: 0, run_id: 'run-1', status: 'completed', output: 'ok' },
        { index: 1, run_id: 'run-2', status: 'failed', error: { code: 'TIMEOUT', message: 'Timed out' } },
      ],
    });

    expect(result.isSuccess).toBe(false);
    expect(result.isPartialFailure).toBe(true);
    expect(result.successfulOutputs()).toEqual(['ok']);
    expect(result.failedItems()).toHaveLength(1);
    expect(result.failedItems()[0].error?.code).toBe('TIMEOUT');
  });

  it('should handle string errors in results', () => {
    const result = new BatchResult({
      batch_id: 'batch-3',
      status: 'failed',
      results: [
        { index: 0, run_id: 'run-1', status: 'failed', error: 'Something broke' },
      ],
    });

    expect(result.results[0].error?.message).toBe('Something broke');
  });

  it('should sort outputs by index', () => {
    const result = new BatchResult({
      batch_id: 'batch-4',
      status: 'completed',
      results: [
        { index: 2, run_id: 'run-3', status: 'completed', output: 'C' },
        { index: 0, run_id: 'run-1', status: 'completed', output: 'A' },
        { index: 1, run_id: 'run-2', status: 'completed', output: 'B' },
      ],
    });

    expect(result.outputs).toEqual(['A', 'B', 'C']);
  });

  it('should handle camelCase keys', () => {
    const result = new BatchResult({
      batchId: 'batch-camel',
      status: 'completed',
      results: [
        { index: 0, runId: 'run-1', status: 'completed', output: 'ok', durationMs: 50 },
      ],
      stats: {
        totalItems: 1,
        completedItems: 1,
        failedItems: 0,
        cancelledItems: 0,
        pendingItems: 0,
        durationMs: 50,
        avgItemDurationMs: 50,
      },
    });

    expect(result.batchId).toBe('batch-camel');
    expect(result.results[0].runId).toBe('run-1');
    expect(result.stats?.totalItems).toBe(1);
  });
});

describe('BatchStatusResult', () => {
  it('should detect running batch', () => {
    const status = new BatchStatusResult({
      batch_id: 'batch-running',
      status: 'running',
      results: [],
    });

    expect(status.isRunning).toBe(true);
    expect(status.isCompleted).toBe(false);
  });

  it('should detect completed batch', () => {
    const status = new BatchStatusResult({
      batch_id: 'batch-done',
      status: 'completed',
      results: [
        { index: 0, run_id: 'run-1', status: 'completed', output: 'done' },
      ],
    });

    expect(status.isRunning).toBe(false);
    expect(status.isCompleted).toBe(true);
  });

  it('should detect partial failure as completed', () => {
    const status = new BatchStatusResult({
      batch_id: 'batch-partial',
      status: 'partial_failure',
    });

    expect(status.isRunning).toBe(false);
    expect(status.isCompleted).toBe(true);
  });
});
