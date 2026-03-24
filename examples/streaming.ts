/**
 * Example: Streaming responses
 *
 * Demonstrates streaming text chunks and typed events from components.
 */

import { Client } from '../src/index.js';

const client = new Client();

// ─── 1. Stream text chunks ──────────────────────────────────────────

async function streamText() {
  console.log('=== Streaming text chunks ===\n');

  for await (const chunk of client.stream('generate-story', { topic: 'space exploration' })) {
    process.stdout.write(chunk);
  }
  console.log('\n');
}

// ─── 2. Stream typed events ─────────────────────────────────────────

async function streamEvents() {
  console.log('=== Streaming typed events ===\n');

  for await (const event of client.events('analyze', { data: 'sample text' })) {
    switch (event.eventType) {
      case 'run.started':
        console.log(`Run started: ${event.data.run_id}`);
        break;

      case 'output.delta':
        process.stdout.write(event.data.chunk || '');
        break;

      case 'agent.iteration.completed':
        console.log(`\nIteration ${event.data.iteration} complete`);
        break;

      case 'tool.call.completed':
        console.log(`Tool ${event.data.tool_name} returned: ${JSON.stringify(event.data.result).slice(0, 100)}`);
        break;

      case 'run.completed':
        console.log(`\nRun completed. Output: ${JSON.stringify(event.data.output).slice(0, 200)}`);
        break;

      case 'error':
        console.error('Error:', event.data.error);
        break;
    }
  }
}

// ─── 3. Stream workflow events ──────────────────────────────────────

async function streamWorkflow() {
  console.log('=== Streaming workflow events ===\n');

  for await (const event of client.events('data-pipeline', { input: 'raw data' }, { componentType: 'workflow' })) {
    console.log(`[${event.eventType}] seq=${event.sequence}`, JSON.stringify(event.data).slice(0, 100));
  }
}

async function main() {
  await streamText();
  await streamEvents();
  await streamWorkflow();
}

main().catch(console.error);
