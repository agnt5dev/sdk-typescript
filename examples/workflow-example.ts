/**
 * Example: Workflow component usage
 *
 * Demonstrates multi-step workflows with checkpointing
 */

import { workflow, ContextImpl } from '../src/index.js';

// Define a data processing workflow
const processDataPipeline = workflow(
  'process-data-pipeline',
  async (ctx, datasetId: string) => {
    console.log(`\nProcessing dataset: ${datasetId}`);

    // Step 1: Load data
    const data = await ctx.step('load-data', async () => {
      console.log('  Loading data...');
      // Simulate data loading
      return [
        { id: 1, value: 10 },
        { id: 2, value: 20 },
        { id: 3, value: 30 }
      ];
    });

    console.log(`  Loaded ${data.length} records`);

    // Step 2: Transform data
    const transformed = await ctx.step('transform-data', async () => {
      console.log('  Transforming data...');
      return data.map(item => ({
        ...item,
        value: item.value * 2,
        processed: true
      }));
    });

    console.log(`  Transformed ${transformed.length} records`);

    // Step 3: Validate data
    const validated = await ctx.step('validate-data', async () => {
      console.log('  Validating data...');
      const valid = transformed.filter(item => item.value > 0);
      return valid;
    });

    console.log(`  Validated ${validated.length} records`);

    // Step 4: Save results
    await ctx.step('save-results', async () => {
      console.log('  Saving results...');
      // Simulate saving
      return true;
    });

    return {
      datasetId,
      recordsProcessed: validated.length,
      finalData: validated
    };
  }
);

// Define an order processing workflow
const processOrder = workflow('process-order', async (ctx, order: any) => {
  console.log(`\nProcessing order: ${order.id}`);

  // Validate order
  await ctx.step('validate-order', async () => {
    console.log('  Validating order...');
    if (!order.items || order.items.length === 0) {
      throw new Error('Order has no items');
    }
    return true;
  });

  // Calculate total
  const total = await ctx.step('calculate-total', async () => {
    console.log('  Calculating total...');
    return order.items.reduce((sum: number, item: any) => sum + item.price, 0);
  });

  console.log(`  Total: $${total}`);

  // Process payment
  await ctx.step('process-payment', async () => {
    console.log('  Processing payment...');
    // Simulate payment processing
    return { status: 'success', transactionId: 'txn-123' };
  });

  // Fulfill order
  await ctx.step('fulfill-order', async () => {
    console.log('  Fulfilling order...');
    // Simulate fulfillment
    return { status: 'shipped', trackingId: 'track-456' };
  });

  // Send confirmation
  await ctx.step('send-confirmation', async () => {
    console.log('  Sending confirmation email...');
    return true;
  });

  return {
    orderId: order.id,
    status: 'completed',
    total
  };
});

async function main() {
  console.log('=== Workflow Example ===');

  // Example 1: Data processing pipeline
  console.log('\n1. Data Processing Pipeline:');
  const result1 = await processDataPipeline(
    new ContextImpl('inv-1', 'run-1', 0, 'workflow-example'),
    'dataset-123'
  );
  console.log('Pipeline result:', result1);

  // Example 2: Order processing
  console.log('\n2. Order Processing:');
  const order = {
    id: 'order-789',
    items: [
      { name: 'Product A', price: 29.99 },
      { name: 'Product B', price: 49.99 }
    ]
  };

  const result2 = await processOrder(
    new ContextImpl('inv-2', 'run-2', 0, 'workflow-example'),
    order
  );
  console.log('Order result:', result2);

  // Example 3: Checkpointing demonstration
  console.log('\n3. Checkpointing (run twice to see checkpoint behavior):');
  const ctx = new ContextImpl('inv-3', 'run-3', 0, 'workflow-example');

  // First run
  console.log('First run:');
  await processDataPipeline(ctx, 'dataset-456');

  // Second run with same context (should skip checkpointed steps)
  console.log('\nSecond run (same context):');
  await processDataPipeline(ctx, 'dataset-456');
}

main().catch(console.error);
