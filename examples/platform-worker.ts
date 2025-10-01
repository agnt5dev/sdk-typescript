/**
 * Platform Integration Example
 *
 * Demonstrates connecting a TypeScript worker to the AGNT5 platform
 * using NAPI bindings to the Rust sdk-core.
 */

import { Worker, fn, checkPlatformConnectivity } from '../src/index.js';

// Define a simple function
// TODO: Update once function registration is implemented in Worker
// const greet = fn('greet')
//   .input<{ name: string }>()
//   .output<string>()
//   .handler(async (ctx, input) => {
//     ctx.logger.info(`Greeting user: ${input.name}`);
//     return `Hello, ${input.name}! Welcome to AGNT5.`;
//   });

async function main() {
  console.log('🚀 AGNT5 TypeScript Platform Worker Example\n');

  // Check platform connectivity
  const coordinatorUrl = process.env.AGNT5_COORDINATOR_ENDPOINT || 'http://localhost:34186';
  console.log(`Checking platform connectivity at ${coordinatorUrl}...`);

  const isReachable = await checkPlatformConnectivity(coordinatorUrl);
  console.log(isReachable ? '✓ Platform is reachable' : '✗ Platform is not reachable');
  console.log();

  // Create worker with platform configuration
  const worker = new Worker('typescript-example-service', {
    serviceName: 'typescript-example-service',
    serviceVersion: '0.1.0',
    serviceType: 'function',
    coordinatorEndpoint: coordinatorUrl,
    tenantId: process.env.AGNT5_TENANT_ID || 'default',
    deploymentId: process.env.AGNT5_DEPLOYMENT_ID || 'local',
  });

  // Start the worker
  console.log('Starting worker...\n');
  await worker.run();

  console.log('\n📝 Configuration:');
  console.log(`   Worker ID: ${worker.workerId}`);
  console.log(`   Coordinator: ${worker.coordinatorEndpoint}`);
  console.log(`   Tenant: ${worker.tenantId}`);
  console.log(`   Deployment: ${worker.deploymentId}`);

  console.log('\n✅ Worker is running and ready to receive invocations');
  console.log('   Press Ctrl+C to stop');

  // Keep the process running
  await new Promise(() => {});
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
