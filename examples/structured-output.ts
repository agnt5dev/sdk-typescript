/**
 * Example: Structured output with LLM
 *
 * Demonstrates getting structured (JSON) output from LLM calls
 * using the LM class with response format options.
 */

import { LM, systemMessage, userMessage, jsonSchemaFormat, Agent, tool } from '../src/index.js';

// ─── 1. JSON schema response format ────────────────────────────────

async function structuredExtraction() {
  const model = new LM({ provider: 'openai', model: 'gpt-4o-mini' });

  const response = await model.generate({
    messages: [
      systemMessage('Extract structured data from user text. Respond in JSON.'),
      userMessage('My name is Alice, I work at Acme Corp as a senior engineer, and I love TypeScript.'),
    ],
    responseFormat: jsonSchemaFormat('person_info', {
      type: 'object',
      properties: {
        name: { type: 'string' },
        company: { type: 'string' },
        role: { type: 'string' },
        interests: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'company', 'role'],
    }),
  });

  console.log('Extracted:', JSON.parse(response.content));
}

// ─── 2. Agent with structured tool output ───────────────────────────

const extractEntities = tool('extract_entities', {
  description: 'Extract named entities from text',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to analyze' },
    },
    required: ['text'],
  },
  handler: async (_ctx, args: { text: string }) => {
    // Simulated entity extraction
    const entities = {
      people: ['Alice', 'Bob'],
      organizations: ['Acme Corp'],
      locations: ['San Francisco'],
    };
    return JSON.stringify(entities);
  },
});

async function agentWithStructuredOutput() {
  const model = new LM({ provider: 'openai', model: 'gpt-4o-mini' });

  const agent = new Agent({
    name: 'entity-extractor',
    model,
    tools: [extractEntities],
    instructions: 'You extract entities from text. Use the extract_entities tool and summarize findings.',
  });

  const result = await agent.run('Alice from Acme Corp met Bob in San Francisco.');
  console.log('Agent output:', result.output);
}

// ─── 3. Function with validated output ──────────────────────────────

import { fn } from '../src/index.js';

const analyzeText = fn('analyze-text', {
  description: 'Analyze text and return structured metrics',
  handler: async (_ctx, text: string) => {
    return {
      wordCount: text.split(/\s+/).length,
      charCount: text.length,
      sentenceCount: text.split(/[.!?]+/).filter(Boolean).length,
      averageWordLength: text.replace(/\s+/g, '').length / text.split(/\s+/).length,
    };
  },
});

async function main() {
  console.log('=== Structured output examples ===\n');

  // Run the local function
  const metrics = await analyzeText.handler(
    { invocationId: '', runId: '', attempt: 0, serviceName: '', logger: console, get: async () => undefined, set: async () => {}, delete: async () => false, step: async (_, fn) => fn() } as any,
    'The quick brown fox jumps over the lazy dog. It was a sunny day.',
  );
  console.log('Text metrics:', metrics);

  // LLM examples require API keys
  // await structuredExtraction();
  // await agentWithStructuredOutput();
}

main().catch(console.error);
