/**
 * Example: Structured output with LLM
 *
 * Demonstrates getting structured (JSON) output from LLM calls
 * using the LM class with response format options.
 */

import { LM, systemMessage, userMessage, jsonSchemaFormat, Agent, tool } from '../src/index.js';

// ─── 1. JSON schema response format ────────────────────────────────

async function structuredExtraction() {
  const model = LM.openai({ apiKey: process.env.OPENAI_API_KEY });

  const response = await model.generate({
    model: 'openai/gpt-4o-mini',
    messages: [
      systemMessage('Extract structured data from user text. Respond in JSON.'),
      userMessage('My name is Alice, I work at Acme Corp as a senior engineer, and I love TypeScript.'),
    ],
    config: { responseFormat: jsonSchemaFormat('person_info', {
      type: 'object',
      properties: {
        name: { type: 'string' },
        company: { type: 'string' },
        role: { type: 'string' },
        interests: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'company', 'role'],
    }) },
  });

  console.log('Extracted:', JSON.parse(response.text));
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
}, async (_ctx, args: { text: string }) => {
  // Simulated entity extraction
  const entities = {
    people: ['Alice', 'Bob'],
    organizations: ['Acme Corp'],
    locations: ['San Francisco'],
  };
  return JSON.stringify(entities);
});

async function agentWithStructuredOutput() {
  const model = LM.openai({ apiKey: process.env.OPENAI_API_KEY });

  const agent = new Agent({
    name: 'entity-extractor',
    model,
    modelName: 'openai/gpt-4o-mini',
    tools: [extractEntities],
    instructions: 'You extract entities from text. Use the extract_entities tool and summarize findings.',
  });

  const result = await agent.run('Alice from Acme Corp met Bob in San Francisco.');
  console.log('Agent output:', result.output);
}

// ─── 3. Function with validated output ──────────────────────────────

import { fn } from '../src/index.js';

const analyzeText = fn<string, { wordCount: number; charCount: number; sentenceCount: number; averageWordLength: number }>('analyze-text').run(async (_ctx, text) => ({
  wordCount: text.split(/\s+/).length,
  charCount: text.length,
  sentenceCount: text.split(/[.!?]+/).filter(Boolean).length,
  averageWordLength: text.replace(/\s+/g, '').length / text.split(/\s+/).length,
}));

async function main() {
  console.log('=== Structured output examples ===\n');

  // Run the local function
  const { ContextImpl } = await import('../src/index.js');
  const metrics = await analyzeText(
    new ContextImpl('example', 'example', 0, 'structured-output', { storage: 'memory' }),
    'The quick brown fox jumps over the lazy dog. It was a sunny day.',
  );
  console.log('Text metrics:', metrics);

  // LLM examples require API keys
  // await structuredExtraction();
  // await agentWithStructuredOutput();
}

main().catch(console.error);
