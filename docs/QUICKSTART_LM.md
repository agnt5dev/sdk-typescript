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
  model: 'gpt-4',
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
  model: 'gpt-4',
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

// Define schema
const schema = jsonSchemaFormat('person', {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'number' },
    email: { type: 'string' }
  },
  required: ['name', 'age']
});

// Force JSON output
const response = await lm.generate({
  model: 'gpt-4',
  messages: [{
    role: 'user',
    content: 'Extract: John Doe, 30, john@example.com'
  }],
  config: {
    responseFormat: schema
  }
});

const person = JSON.parse(response.text);
console.log(person.name);  // "John Doe"
```

## Supported Providers

### OpenAI

```typescript
const lm = LM.openai({
  apiKey: 'sk-...'  // Optional, reads from OPENAI_API_KEY
});
```

**Models:** `gpt-4`, `gpt-4-turbo`, `o1-preview`, `o3-mini`

### Anthropic (Claude)

```typescript
const lm = LM.anthropic({
  apiKey: 'sk-ant-...'  // Optional, reads from ANTHROPIC_API_KEY
});
```

**Models:** `claude-3-5-sonnet-20241022`, `claude-3-opus-20240229`

### Groq (Fast!)

```typescript
const lm = LM.groq({
  apiKey: 'gsk_...'  // Optional, reads from GROQ_API_KEY
});
```

**Models:** `mixtral-8x7b-32768`, `llama2-70b-4096`

### Azure OpenAI

```typescript
const lm = LM.azure({
  apiKey: 'your-key',
  endpoint: 'https://your-resource.openai.azure.com'
});
```

### AWS Bedrock

```typescript
const lm = LM.bedrock({
  region: 'us-east-1',
  accessKeyId: 'AKIA...',
  secretAccessKey: 'secret'
});
```

### OpenRouter (100+ Models)

```typescript
const lm = LM.openrouter({
  apiKey: 'sk-or-...'  // Optional, reads from OPENROUTER_API_KEY
});
```

## Configuration Options

```typescript
const response = await lm.generate({
  model: 'gpt-4',
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
const conversation = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'My name is Alice' },
  { role: 'assistant', content: 'Nice to meet you, Alice!' },
  { role: 'user', content: 'What did I tell you?' }
];

const response = await lm.generate({
  model: 'gpt-4',
  messages: conversation
});
```

### Retry on Failure

```typescript
import { executeWithRetry } from '@agnt5/sdk';

const response = await executeWithRetry(async () => {
  return await lm.generate({
    model: 'gpt-4',
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
  const providers = [
    () => LM.openai(),
    () => LM.anthropic(),
    () => LM.groq()
  ];

  for (const createLM of providers) {
    try {
      const lm = createLM();
      return await lm.generate({
        model: 'gpt-4',
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

### "Could not find native LM bindings"

**Solution:** Build the native module:

```bash
npm run build
```

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
- 🐛 [Report Issues](https://github.com/agnt5/agnt5/issues)
- 💬 [Community Discord](https://discord.gg/agnt5)

---

**Built with AGNT5** 🚀
