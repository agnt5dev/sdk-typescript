# Quick Start: Language Models with AGNT5

Get started with LLM integration in under 5 minutes!

## Installation

```bash
npm install @agnt5/sdk
```

## Setup

Set your API key:

```bash
export OPENAI_API_KEY="sk-..."
# OR
export ANTHROPIC_API_KEY="sk-ant-..."
# OR
export GROQ_API_KEY="gsk_..."
```

## Basic Usage

### 1. Simple Completion

```typescript
import { LM } from '@agnt5/sdk';

// Create LLM client
const lm = LM.openai();

// Generate response
const response = await lm.generate({
  model: 'openai/gpt-6-luna',
  messages: [
    { role: 'user', content: 'What is TypeScript?' }
  ]
});

console.log(response.text);
```

### 2. Streaming Response

```typescript
import { LM } from '@agnt5/sdk';

const lm = LM.openai();

await lm.stream({
  model: 'openai/gpt-6-luna',
  messages: [
    { role: 'user', content: 'Tell me a story' }
  ]
}, (chunk) => {
  if (chunk.chunkType === 'delta') {
    process.stdout.write(chunk.content || '');
  }
});
```

### 3. Agent with Tools

```typescript
import { Agent, LM, tool } from '@agnt5/sdk';

// Define a tool
const weatherTool = tool('get_weather', {
  description: 'Get current weather',
  inputSchema: {
    type: 'object',
    properties: {
      location: { type: 'string' }
    },
    required: ['location']
  }
}, async (ctx, args) => {
  // Your implementation
  return { temp: 72, condition: 'sunny' };
});

// Create agent
const lm = LM.openai();

const agent = new Agent({
  name: 'assistant',
  model: lm,
  modelName: 'openai/gpt-6-luna',
  instructions: 'You are a helpful assistant.',
  tools: [weatherTool]
});

// Run agent
const result = await agent.run('What\'s the weather in Paris?');
console.log(result.output);
```

### 4. Structured Output

```typescript
import { LM, jsonSchemaFormat } from '@agnt5/sdk';

const lm = LM.openai();

// Define schema. OpenAI's strict mode, the default, needs every property
// in `required` and `additionalProperties: false`; allow null for a value
// that may be missing.
const schema = jsonSchemaFormat('person', {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'number' },
    email: { anyOf: [{ type: 'string' }, { type: 'null' }] }
  },
  required: ['name', 'age', 'email'],
  additionalProperties: false
});

// Force JSON output
const response = await lm.generate({
  model: 'openai/gpt-6-luna',
  messages: [{
    role: 'user',
    content: 'Extract: John Doe, 30, john@example.com'
  }],
  config: {
    responseFormat: schema
  }
});

const person = response.structuredOutput as { name: string; age: number; email: string | null };
console.log(person.name);  // "John Doe"
```

See [Structured Output](./lm.md#structured-output-json-schema) for what strict mode accepts.

Every model name starts with its provider: `openai/gpt-6-luna`, not `gpt-6-luna`. The SDK rejects a bare name with "Model must include provider prefix".

## Supported Providers

### OpenAI

```typescript
const lm = LM.openai({
  apiKey: 'sk-...'  // Optional, reads from OPENAI_API_KEY
});
```

**Models:** `openai/gpt-6-luna`, `openai/gpt-6.1-sol`, `openai/gpt-4.1-mini`

### Anthropic (Claude)

```typescript
const lm = LM.anthropic({
  apiKey: 'sk-ant-...'  // Optional, reads from ANTHROPIC_API_KEY
});
```

**Models:** `anthropic/claude-sonnet-5`, `anthropic/claude-opus-5-5`, `anthropic/claude-haiku-4-5`

### Groq (Fast!)

```typescript
const lm = LM.groq({
  apiKey: 'gsk_...'  // Optional, reads from GROQ_API_KEY
});
```

**Models:** `groq/llama-3.3-70b-versatile`, `groq/llama-3.1-8b-instant`, `groq/openai/gpt-oss-120b`

### Azure OpenAI

```typescript
const lm = LM.azure({
  apiKey: 'your-key',
  endpoint: 'https://your-resource.openai.azure.com'
});
```

**Models:** `azure/` + your deployment name, such as `azure/your-deployment`

### AWS Bedrock

```typescript
const lm = LM.bedrock({
  region: 'us-east-1',
  accessKeyId: 'AKIA...',
  secretAccessKey: 'secret'
});
```

**Models:** `bedrock/` + the Bedrock model ID, such as `bedrock/us.anthropic.claude-sonnet-5`

### OpenRouter (Hundreds of Models)

```typescript
const lm = LM.openrouter({
  apiKey: 'sk-or-...'  // Optional, reads from OPENROUTER_API_KEY
});
```

**Models:** OpenRouter's model IDs, such as `anthropic/claude-sonnet-5`

## Configuration Options

```typescript
const response = await lm.generate({
  model: 'openai/gpt-4.1-mini',  // reasoning models such as gpt-6-luna ignore temperature and topP
  messages: [/* ... */],
  config: {
    temperature: 0.7,        // Randomness (0.0 - 2.0)
    topP: 0.9,              // Nucleus sampling
    maxOutputTokens: 1000   // Max response length
  }
});
```

## Common Patterns

### Conversation with Context

```typescript
import type { LMMessage } from '@agnt5/sdk';

const conversation: LMMessage[] = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'My name is Alice' },
  { role: 'assistant', content: 'Nice to meet you, Alice!' },
  { role: 'user', content: 'What did I tell you?' }
];

const response = await lm.generate({
  model: 'openai/gpt-6-luna',
  messages: conversation
});
```

### Retry on Failure

```typescript
import { executeWithRetry } from '@agnt5/sdk';

const response = await executeWithRetry(async () => {
  return await lm.generate({
    model: 'openai/gpt-6-luna',
    messages: [/* ... */]
  });
}, {
  retryPolicy: { maxAttempts: 3 },
  backoffPolicy: 'exponential'
});
```

### Multi-Provider Fallback

```typescript
async function generateWithFallback(prompt: string) {
  // Each provider needs its own model name.
  const providers = [
    { createLM: () => LM.openai(), model: 'openai/gpt-6-luna' },
    { createLM: () => LM.anthropic(), model: 'anthropic/claude-sonnet-5' },
    { createLM: () => LM.groq(), model: 'groq/llama-3.3-70b-versatile' }
  ];

  for (const { createLM, model } of providers) {
    try {
      const lm = createLM();
      return await lm.generate({
        model,
        messages: [{ role: 'user', content: prompt }]
      });
    } catch (error) {
      continue;  // Try next provider
    }
  }

  throw new Error('All providers failed');
}
```

## Next Steps

- 📖 Read the [Complete LM Guide](./lm.md)
- 🔧 Explore [Tool Calling](./lm.md#tool-calling)
- 🤖 Build [Agents](./lm.md#integration-with-agents)
- 📊 See [Examples](../examples/)

## Troubleshooting

### "Model must include provider prefix"

**Solution:** Start the model name with its provider: `'openai/gpt-6-luna'`, not `'gpt-6-luna'`.

### "Invalid schema for response_format"

**Solution:** OpenAI's strict mode rejected the schema. See [Structured Output](./lm.md#structured-output-json-schema).

### "Invalid API key"

**Solution:** Set the environment variable:

```bash
export OPENAI_API_KEY="sk-..."
```

### Rate Limiting

**Solution:** Add retry logic:

```typescript
import { executeWithRetry } from '@agnt5/sdk';

const response = await executeWithRetry(
  () => lm.generate({ /* ... */ }),
  { retryPolicy: { maxAttempts: 5 } }
);
```

## Support

- 📚 [Full Documentation](./lm.md)
- 🐛 [Report Issues](https://github.com/agnt5dev/sdk-typescript/issues)
- 💬 [Community Discord](https://discord.gg/agnt5)

---

**Built with AGNT5** 🚀
