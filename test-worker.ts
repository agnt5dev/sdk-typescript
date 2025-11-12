import { fn } from './dist/src/function.js';
import { Worker } from './dist/src/worker.js';

// Define a simple test function
export const greet = fn('greet').run(async (ctx, name: string) => {
  ctx.logger.info(`Greeting ${name}`);
  return `Hello, ${name}!`;
});

export const add = fn('add').run(async (ctx, a: number, b: number) => {
  ctx.logger.info(`Adding ${a} + ${b}`);
  return a + b;
});

// Create and run worker
const worker = new Worker('test-typescript-worker', {
  serviceVersion: '0.1.0',
  serviceType: 'function',
});

console.log('Starting TypeScript test worker...');
await worker.run();
