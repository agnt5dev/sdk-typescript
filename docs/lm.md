# Language Model (LM) Integration

Complete guide to using language models with the AGNT5 TypeScript SDK.

## Overview

The AGNT5 SDK provides a unified interface to multiple LLM providers through the `LM` class. All providers support:

- ✅ Text generation
- ✅ Streaming responses
- ✅ Tool calling
- ✅ Structured output (JSON Schema)
- ✅ Token usage tracking
- ✅ Configurable parameters

## Supported Providers

| Provider | Models | Strengths |
|----------|--------|-----------|
| **OpenAI** | GPT-6 (gpt-6-luna, gpt-6.1-sol), GPT-4.1 | Best overall quality, reasoning models |
| **Anthropic** | Claude Opus 5.5, Sonnet 5, Haiku 4.5 | Long context, analysis |
| **Azure OpenAI** | Your OpenAI deployments | Enterprise deployment |
| **AWS Bedrock** | Claude, Llama and other Bedrock models | AWS integration |
| **Groq** | Llama 3.3, gpt-oss | Fast inference |
| **OpenRouter** | Hundreds of models | Model aggregation |

The SDK also has `LM.google()`, `LM.mistral()`, `LM.xai()`, `LM.deepseek()`, `LM.together()`, `LM.fireworks()`, `LM.ollama()` and more; see the [API reference](#lm-class).

## Quick Start

### Installation

```bash
npm install @agnt5/sdk
```

### Basic Usage

```typescript
import { LM } from '@agnt5/sdk';

// Create LLM client
const lm = LM.openai({ apiKey: process.env.OPENAI_API_KEY });

// Generate completion
const response = await lm.generate({
  model: 'openai/gpt-6-luna',
  messages: [
    { role: 'user', content: 'What is 2+2?' }
  ]
});

console.log(response.text); // "4"
console.log(response.usage); // Token usage statistics
```

### Model Names

Every model name starts with its provider, the same one as the `LM` you call it on: `openai/gpt-6-luna` with `LM.openai()`, `anthropic/claude-sonnet-5` with `LM.anthropic()`. A bare name such as `'gpt-4'` is rejected before any request is sent:

```text
Model must include provider prefix (e.g., 'openai/gpt-4')
```

## Provider Configuration

### OpenAI

```typescript
const lm = LM.openai({
  apiKey: 'sk-...',              // Optional: defaults to OPENAI_API_KEY env var
  organizationId: 'org-...',     // Optional: for org-based billing
  baseUrl: 'https://...'         // Optional: for custom endpoints
});

// Use with models
const response = await lm.generate({
  model: 'openai/gpt-6-luna',    // or 'openai/gpt-6.1-sol', 'openai/gpt-4.1-mini'
  messages: [/* ... */]
});
```

**Environment Variables:**
- `OPENAI_API_KEY` - API key
- `OPENAI_ORG_ID` - Organization ID

### Anthropic (Claude)

```typescript
const lm = LM.anthropic({
  apiKey: 'sk-ant-...',          // Optional: defaults to ANTHROPIC_API_KEY
  baseUrl: 'https://...'         // Optional: for custom endpoints
});

// Use with Claude models
const response = await lm.generate({
  model: 'anthropic/claude-sonnet-5',  // or 'anthropic/claude-opus-5-5', 'anthropic/claude-haiku-4-5'
  messages: [/* ... */]
});
```

**Environment Variables:**
- `ANTHROPIC_API_KEY` - API key

### Azure OpenAI

```typescript
const lm = LM.azure({
  apiKey: 'your-key',                                    // Optional: defaults to AZURE_OPENAI_API_KEY
  endpoint: 'https://your-resource.openai.azure.com',   // Required
  apiVersion: '2024-02-01'                              // Optional: API version
});

// Use with your deployment
const response = await lm.generate({
  model: 'azure/your-deployment',  // 'azure/' + your deployment name
  messages: [/* ... */]
});
```

**Environment Variables:**
- `AZURE_OPENAI_API_KEY` - API key

### AWS Bedrock

```typescript
const lm = LM.bedrock({
  region: 'us-east-1',                              // Optional: defaults to AWS_REGION
  accessKeyId: 'AKIA...',                           // Optional: defaults to AWS_ACCESS_KEY_ID
  secretAccessKey: 'secret',                        // Optional: defaults to AWS_SECRET_ACCESS_KEY
  sessionToken: 'token'                             // Optional: for temporary credentials
});

// Use with Bedrock models: 'bedrock/' + the Bedrock model ID
const response = await lm.generate({
  model: 'bedrock/us.anthropic.claude-sonnet-5',
  messages: [/* ... */]
});
```

**Environment Variables:**
- `AWS_ACCESS_KEY_ID` - AWS access key
- `AWS_SECRET_ACCESS_KEY` - AWS secret key
- `AWS_SESSION_TOKEN` - Session token (optional)
- `AWS_REGION` - AWS region

### Groq

```typescript
const lm = LM.groq({
  apiKey: 'gsk_...',             // Optional: defaults to GROQ_API_KEY
  baseUrl: 'https://...'         // Optional: for custom endpoints
});

// Use with Groq models (ultra-fast inference)
const response = await lm.generate({
  model: 'groq/llama-3.3-70b-versatile',  // or 'groq/openai/gpt-oss-120b'
  messages: [/* ... */]
});
```

**Environment Variables:**
- `GROQ_API_KEY` - API key

### OpenRouter

```typescript
const lm = LM.openrouter({
  apiKey: 'sk-or-...',           // Optional: defaults to OPENROUTER_API_KEY
  baseUrl: 'https://...'         // Optional: for custom endpoints
});

// Use with any model on OpenRouter, by its OpenRouter ID
const response = await lm.generate({
  model: 'anthropic/claude-sonnet-5',
  messages: [/* ... */]
});
```

**Environment Variables:**
- `OPENROUTER_API_KEY` - API key

## Generation Options

### Basic Configuration

```typescript
const response = await lm.generate({
  model: 'openai/gpt-4.1-mini',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello!' }
  ],
  config: {
    temperature: 0.7,          // Randomness (0.0 - 2.0)
    topP: 0.9,                // Nucleus sampling
    maxOutputTokens: 1000     // Maximum response length
  }
});
```

Reasoning models such as `openai/gpt-6-luna` don't take `temperature` or `topP`; the SDK leaves them out of the request and logs a warning.

### Streaming Responses

```typescript
await lm.stream({
  model: 'openai/gpt-6-luna',
  messages: [{ role: 'user', content: 'Tell me a story' }]
}, (chunk) => {
  if (chunk.chunkType === 'delta') {
    // Stream content as it arrives
    process.stdout.write(chunk.content || '');
  } else if (chunk.chunkType === 'completed') {
    // Final response with metadata
    console.log('\n\nTokens used:', chunk.response?.usage);
  }
});
```

### Tool Calling

```typescript
import { createTool } from '@agnt5/sdk';

// Define a tool. createTool() uses OpenAI's strict mode, so the schema
// follows the same rules as structured output (see below).
const weatherTool = createTool(
  'get_weather',
  'Get current weather for a location',
  {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'City name' },
      units: { anyOf: [{ type: 'string', enum: ['celsius', 'fahrenheit'] }, { type: 'null' }] }
    },
    required: ['location', 'units'],
    additionalProperties: false
  }
);

// Use with LLM
const response = await lm.generate({
  model: 'openai/gpt-6-luna',
  messages: [{ role: 'user', content: 'What\'s the weather in Paris?' }],
  tools: [weatherTool],
  toolChoice: { choiceType: 'auto' }
});

// Check for tool calls
if (response.toolCalls && response.toolCalls.length > 0) {
  const call = response.toolCalls[0];
  console.log('Tool:', call.name);
  console.log('Arguments:', JSON.parse(call.arguments));

  // Execute tool and continue conversation...
}
```

### Structured Output (JSON Schema)

```typescript
import { jsonSchemaFormat } from '@agnt5/sdk';

// Define output schema
const schema = jsonSchemaFormat('person', {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'number' },
    email: { anyOf: [{ type: 'string', format: 'email' }, { type: 'null' }] }  // null when the text has none
  },
  required: ['name', 'age', 'email'],
  additionalProperties: false
});

// Force structured output
const response = await lm.generate({
  model: 'openai/gpt-6-luna',
  messages: [{
    role: 'user',
    content: 'Extract person info: John Doe, 30 years old, john@example.com'
  }],
  config: {
    responseFormat: schema
  }
});

// The parsed JSON
const person = response.structuredOutput as { name: string; age: number; email: string | null };
console.log(person.name);  // "John Doe"
console.log(person.age);   // 30
```

`jsonSchemaFormat()` asks for OpenAI's strict mode by default, which only accepts a schema that:

- sets `additionalProperties: false` on every object, nested ones included;
- lists every property in `required`. For a value the model may leave out, allow `null` with `anyOf`, as `email` does above.

Strict mode rejects any other schema with a 400 (`Invalid schema for response_format`). To send a schema without strict mode, pass `false` as the third argument: `jsonSchemaFormat('person', schema, false)`.

## Advanced Features

### Reasoning Models

```typescript
const response = await lm.generate({
  model: 'openai/gpt-6.1-sol',
  messages: [{ role: 'user', content: 'Solve this complex problem...' }],
  config: {
    reasoningEffort: 'high'  // 'none' | 'minimal' | 'low' | 'medium' | 'high'
  }
});
```

Models accept different subsets of these levels. For example, `gpt-6.1-sol` rejects `'none'` and `gpt-6-luna` rejects `'minimal'`.

### Built-in Tools (OpenAI)

```typescript
const response = await lm.generate({
  model: 'openai/gpt-6-luna',
  messages: [{ role: 'user', content: 'Search for Python tutorials' }],
  config: {
    builtInTools: ['web_search']  // OpenAI runs the search and the model uses the results
  }
});
```

## Message Helpers

```typescript
import { systemMessage, userMessage, assistantMessage } from '@agnt5/sdk';

const messages = [
  systemMessage('You are a helpful coding assistant.'),
  userMessage('How do I reverse a string in Python?'),
  assistantMessage('You can use slice notation: s[::-1]'),
  userMessage('Can you show me an example?')
];

const response = await lm.generate({ model: 'openai/gpt-6-luna', messages });
```

## Error Handling

```typescript
try {
  const response = await lm.generate({
    model: 'openai/gpt-6-luna',
    messages: [/* ... */]
  });
} catch (error) {
  if (error.message.includes('API key')) {
    console.error('Invalid API key');
  } else if (error.message.includes('rate limit')) {
    console.error('Rate limited - retry after delay');
  } else {
    console.error('Generation failed:', error);
  }
}
```

## Best Practices

### 1. Use Environment Variables

```typescript
// ✅ Good: Reads from environment
const lm = LM.openai();

// ❌ Bad: Hardcoded key
const lm = LM.openai({ apiKey: 'sk-...' });
```

### 2. Handle Token Limits

```typescript
const response = await lm.generate({
  model: 'openai/gpt-6-luna',
  messages: longConversation,
  config: {
    maxOutputTokens: 2000  // Prevent runaway costs
  }
});

// Check usage
if (response.usage) {
  console.log(`Used ${response.usage.totalTokens} tokens`);
}
```

### 3. Implement Retry Logic

```typescript
import { executeWithRetry } from '@agnt5/sdk';

const response = await executeWithRetry(async () => {
  return await lm.generate({
    model: 'openai/gpt-6-luna',
    messages: [/* ... */]
  });
}, {
  retryPolicy: { maxAttempts: 3, initialIntervalMs: 1000 },
  backoffPolicy: 'exponential',
  jitter: true
});
```

### 4. Use Streaming for Long Responses

```typescript
// ✅ Good: Stream to user immediately
await lm.stream({ /* ... */ }, (chunk) => {
  if (chunk.chunkType === 'delta') {
    displayToUser(chunk.content);
  }
});

// ❌ Bad: Wait for entire response
const response = await lm.generate({ /* ... */ });
displayToUser(response.text);  // User waits longer
```

## Integration with Agents

```typescript
import { Agent, LM } from '@agnt5/sdk';

// Create LLM-powered agent
const lm = LM.openai();

const agent = new Agent({
  name: 'assistant',
  model: lm,
  modelName: 'openai/gpt-6-luna',  // without it, the agent uses openai/gpt-4o-mini
  instructions: 'You are a helpful assistant.',
  tools: [/* your tools */]
});

// Run agent
const result = await agent.run('Help me with this task');
console.log(result.output);
```

## Performance Tips

### 1. Choose the Right Model

```typescript
// Fast, cheap tasks
const quick = await LM.groq().generate({  // Fastest inference
  model: 'groq/llama-3.1-8b-instant',
  messages: [/* ... */]
});

// Complex reasoning tasks
const careful = await LM.openai().generate({
  model: 'openai/gpt-6.1-sol',  // Best reasoning
  messages: [/* ... */]
});
```

### 2. Use Lower Temperature for Deterministic Output

```typescript
const response = await lm.generate({
  model: 'openai/gpt-4.1-mini',  // reasoning models don't take temperature
  messages: [/* ... */],
  config: {
    temperature: 0.0  // Most deterministic
  }
});
```

### 3. Optimize Token Usage

```typescript
// ✅ Use system prompt for instructions
const good = await lm.generate({
  model: 'openai/gpt-6-luna',
  systemPrompt: 'Always respond in JSON format.',  // Reusable across requests
  messages: [{ role: 'user', content: 'Get user data' }]
});

// ❌ Repeat instructions in every message
const bad = await lm.generate({
  model: 'openai/gpt-6-luna',
  messages: [{
    role: 'user',
    content: 'Always respond in JSON format. Get user data'  // Wastes tokens
  }]
});
```

## Examples

### Example 1: Simple Q&A

```typescript
import { LM, userMessage } from '@agnt5/sdk';

const lm = LM.openai();

const response = await lm.generate({
  model: 'openai/gpt-6-luna',
  messages: [userMessage('What is TypeScript?')]
});

console.log(response.text);
```

### Example 2: Conversation with Context

```typescript
const lm = LM.anthropic();

const conversation = [
  { role: 'user' as const, content: 'My name is Alice' },
  { role: 'assistant' as const, content: 'Nice to meet you, Alice!' },
  { role: 'user' as const, content: 'What did I just tell you?' }
];

const response = await lm.generate({
  model: 'anthropic/claude-sonnet-5',
  messages: conversation
});

console.log(response.text);  // "You told me your name is Alice."
```

### Example 3: Code Generation with Streaming

```typescript
const lm = LM.openai();

console.log('Generating code...\n');

await lm.stream({
  model: 'openai/gpt-6-luna',
  systemPrompt: 'You are an expert TypeScript developer.',
  messages: [{
    role: 'user',
    content: 'Write a function to calculate Fibonacci numbers'
  }]
}, (chunk) => {
  if (chunk.chunkType === 'delta' && chunk.content) {
    process.stdout.write(chunk.content);
  }
});

console.log('\n\nDone!');
```

### Example 4: Structured Data Extraction

```typescript
import { LM, jsonSchemaFormat } from '@agnt5/sdk';

const lm = LM.openai();

const extractionSchema = jsonSchemaFormat('contact', {
  type: 'object',
  properties: {
    name: { type: 'string' },
    email: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    phone: { anyOf: [{ type: 'string' }, { type: 'null' }] }
  },
  required: ['name', 'email', 'phone'],
  additionalProperties: false
});

const response = await lm.generate({
  model: 'openai/gpt-6-luna',
  messages: [{
    role: 'user',
    content: 'Extract contact info: John Smith, john@example.com, 555-1234'
  }],
  config: {
    responseFormat: extractionSchema
  }
});

console.log(response.structuredOutput);
// { name: 'John Smith', email: 'john@example.com', phone: '555-1234' }
```

### Example 5: Multi-Provider Fallback

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
      console.warn(`Provider failed, trying next...`);
      continue;
    }
  }

  throw new Error('All providers failed');
}

const response = await generateWithFallback('Hello!');
```

## API Reference

### LM Class

#### Static Methods

- `LM.openai(config?: OpenAIConfig): LM`
- `LM.anthropic(config?: AnthropicConfig): LM`
- `LM.azure(config: AzureOpenAIConfig): LM`
- `LM.bedrock(config: BedrockConfig): LM`
- `LM.groq(config?: GroqConfig): LM`
- `LM.openrouter(config?: OpenRouterConfig): LM`
- `LM.google()`, `LM.mistral()`, `LM.xai()`, `LM.deepseek()`, `LM.together()`, `LM.fireworks()`, `LM.baseten()`, `LM.lepton()`, `LM.moonshot()`, `LM.huggingface()`, `LM.ollama()`
- `LM.openaiChat(config?: OpenAiChatConfig): LM`, for other OpenAI-compatible APIs (models are `openai_chat/<model>`)

#### Instance Methods

- `generate(request: GenerateRequest): Promise<GenerateResponse>`
- `stream(request: GenerateRequest, callback: (chunk: StreamChunk) => void): Promise<void>`

### Types

The most used fields; the SDK's type definitions have the rest.

```typescript
interface GenerateRequest {
  model: string;                 // 'provider/model', e.g. 'openai/gpt-6-luna'
  systemPrompt?: string;
  messages?: Message[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoiceOption;
  userId?: string;
  config?: GenerationConfig;
}

interface GenerateResponse {
  id: string;
  model: string;
  created?: number;
  text: string;
  structuredOutput?: unknown;    // the parsed JSON, with a responseFormat
  usage?: TokenUsage;
  finishReason?: string;
  toolCalls?: ToolCall[];
  raw?: string;
}

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface GenerationConfig {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  responseFormat?: ResponseFormatOption;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  builtInTools?: ('web_search' | 'code_interpreter' | 'file_search' | 'web_fetch')[];
}
```

## Troubleshooting

### "Model must include provider prefix"

**Solution:** Start the model name with its provider, matching the `LM` you call: `'openai/gpt-6-luna'`, not `'gpt-6-luna'`. See [Model Names](#model-names).

### "Invalid schema for response_format"

**Solution:** OpenAI's strict mode rejected the schema. Set `additionalProperties: false` on every object and list every property in `required`, or pass `false` as `jsonSchemaFormat()`'s third argument. See [Structured Output](#structured-output-json-schema).

### "Invalid API key"

**Solution:** Set the appropriate environment variable:

```bash
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GROQ_API_KEY="gsk_..."
```

### Rate Limiting

**Solution:** Implement exponential backoff:

```typescript
import { executeWithRetry } from '@agnt5/sdk';

const response = await executeWithRetry(
  () => lm.generate({ /* ... */ }),
  {
    retryPolicy: { maxAttempts: 5, initialIntervalMs: 1000 },
    backoffPolicy: 'exponential',
    jitter: true
  }
);
```

### Streaming Stops Early

**Solution:** Check for errors in the callback:

```typescript
await lm.stream({ /* ... */ }, (chunk) => {
  try {
    // Your processing logic
    if (chunk.chunkType === 'delta') {
      processChunk(chunk.content);
    }
  } catch (error) {
    console.error('Chunk processing error:', error);
    // Don't throw - it will stop the stream
  }
});
```

## Next Steps

- Read about [Agent Integration](./agent.md)
- Learn about [Tool Calling](./tool.md)
- Explore [Workflow Orchestration](./workflow.md)
- See [Complete Examples](../examples/)
