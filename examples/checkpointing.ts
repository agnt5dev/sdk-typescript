/**
 * Checkpointing example
 *
 * Demonstrates:
 * - Multi-step process with checkpoints
 * - Checkpoint replay on retry
 * - Step-based error recovery
 */

import { fn, ContextImpl } from '../src/index.js';

interface DataPipelineResult {
  datasetId: string;
  recordsProcessed: number;
  recordsValidated: number;
}

// Simulate data loading
async function loadData(datasetId: string): Promise<any[]> {
  console.log(`Loading data for dataset: ${datasetId}`);
  return [{ id: 1 }, { id: 2 }, { id: 3 }];
}

// Simulate data transformation
async function transformData(data: any[]): Promise<any[]> {
  console.log(`Transforming ${data.length} records`);
  return data.map((item) => ({ ...item, transformed: true }));
}

// Simulate data validation
async function validateData(data: any[]): Promise<any[]> {
  console.log(`Validating ${data.length} records`);
  return data.filter(() => Math.random() > 0.1); // 90% pass rate
}

// Define pipeline with checkpoints
export const dataPipeline = fn('data-pipeline').run(
  async (ctx, datasetId: string): Promise<DataPipelineResult> => {
    // Step 1: Load data (checkpointed)
    const loaded = await ctx.step('load', () => loadData(datasetId));
    ctx.logger.info(`Loaded ${loaded.length} records`);

    // Step 2: Transform data (checkpointed)
    const transformed = await ctx.step('transform', () => transformData(loaded));
    ctx.logger.info(`Transformed ${transformed.length} records`);

    // Step 3: Validate (checkpointed)
    const validated = await ctx.step('validate', () => validateData(transformed));
    ctx.logger.info(`Validated ${validated.length} records`);

    return {
      datasetId,
      recordsProcessed: transformed.length,
      recordsValidated: validated.length,
    };
  }
);

// Run the example
async function main() {
  const ctx = new ContextImpl('inv-2', 'run-2', 0, 'pipeline-service');

  const result = await dataPipeline(ctx, 'dataset-123');
  console.log('Pipeline result:', result);

  // Try calling again - steps will be skipped due to checkpoints
  console.log('\nRunning again (should skip steps):');
  const result2 = await dataPipeline(ctx, 'dataset-123');
  console.log('Second run result:', result2);
}

// Execute
main().catch(console.error);
