/**
 * Basic function example
 *
 * Demonstrates:
 * - Simple function definition
 * - Context usage
 * - Direct invocation
 */

import { fn, ContextImpl } from '../src/index.js';

// Define a simple greeting function
export const greet = fn('greet').run(async (ctx, name: string) => {
  ctx.logger.info(`Greeting ${name}`);
  return `Hello, ${name}!`;
});

// Run the example
async function main() {
  // Create a context
  const ctx = new ContextImpl('inv-1', 'run-1', 0, 'example-service');

  // Call the function
  const result = await greet(ctx, 'World');
  console.log(result); // Output: Hello, World!
}

// Execute
main().catch(console.error);
