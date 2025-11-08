// Simple worker example to test platform connectivity
import { fn, Worker } from '../src/index.js';

// Define a simple function
const greet = fn('greet').run(async (ctx, name: string) => {
  ctx.logger.info(`Greeting ${name}`);
  return `Hello, ${name}! (from TypeScript SDK)`;
});

const add = fn('add').run(async (ctx, a: number, b: number) => {
  ctx.logger.info(`Adding ${a} + ${b}`);
  return a + b;
});

// Create and run worker
const worker = new Worker('typescript-test-service', {
  serviceVersion: '0.1.0',
});

console.log('Starting TypeScript worker...');
await worker.run();
