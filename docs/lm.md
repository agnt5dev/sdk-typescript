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
| **OpenAI** | GPT-4, GPT-4 Turbo, o1, o3 | Best overall quality, reasoning models |
| **Anthropic** | Claude 3.5 Sonnet, Claude 3 Opus | Long context, analysis |
| **Azure OpenAI** | GPT-4, GPT-3.5 | Enterprise deployment |
| **AWS Bedrock** | Claude, Llama, etc. | AWS integration |
| **Groq** | Mixtral, Llama | Fast inference |
| **OpenRouter** | 100+ models | Model aggregation |

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
  model: 'gpt-4',
  messages: [
    { role: 'user', content: 'What is 2+2?' }
  ]
});

console.log(response.text); // "4"
console.log(response.usage); // Token usage statistics
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
  model: 'gpt-4',                // or 'gpt-4-turbo', 'o1-preview', 'o3-mini'
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
  model: 'claude-3-5-sonnet-20241022',
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
  model: 'gpt-4',  // Your deployment name
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

// Use with Bedrock models
const response = await lm.generate({
  model: 'anthropic.claude-3-sonnet-20240229-v1:0',
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
  model: 'mixtral-8x7b-32768',   // or 'llama2-70b-4096'
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

// Use with any model on OpenRouter
const response = await lm.generate({
  model: 'anthropic/claude-3-opus',  // 100+ models available
  messages: [/* ... */]
});
```

**Environment Variables:**
- `OPENROUTER_API_KEY` - API key

## Generation Options

### Basic Configuration

```typescript
const response = await lm.generate({
  model: 'gpt-4',
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

### Streaming Responses

```typescript
await lm.stream({
  model: 'gpt-4',
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

// Define a tool
const weatherTool = createTool(
  'get_weather',
  'Get current weather for a location',
  {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'City name' },
      units: { type: 'string', enum: ['celsius', 'fahrenheit'] }
    },
    required: ['location']
  }
);

// Use with LLM
const response = await lm.generate({
  model: 'gpt-4',
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
    email: { type: 'string', format: 'email' }
  },
  required: ['name', 'age']
});

// Force structured output
const response = await lm.generate({
  model: 'gpt-4',
  messages: [{
    role: 'user',
    content: 'Extract person info: John Doe, 30 years old, john@example.com'
  }],
  config: {
    responseFormat: schema
  }
});

// Parse JSON response
const person = JSON.parse(response.text);
console.log(person.name);  // "John Doe"
console.log(person.age);   // 30
```

## Advanced Features

### Reasoning Models (o1, o3)

```typescript
const response = await lm.generate({
  model: 'o1-preview',
  messages: [{ role: 'user', content: 'Solve this complex problem...' }],
  config: {
    reasoningEffort: 'high'  // 'minimal' | 'medium' | 'high'
  }
});

// Access reasoning tokens
console.log('Reasoning tokens:', response.usage?.promptTokens);
```

### Multimodal Output

```typescript
const response = await lm.generate({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Describe this in audio' }],
  config: {
    modalities: ['text', 'audio']  // Enable audio output
  }
});
```

### Built-in Tools (OpenAI)

```typescript
const response = await lm.generate({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Search for Python tutorials' }],
  config: {
    builtInTools: [
      'web_search',        // Web search ($25-50 per 1000 queries)
      'code_interpreter',  // Python code execution (included)
      'file_search'        // Document search ($2.50 per 1000 queries)
    ]
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

const response = await lm.generate({ model: 'gpt-4', messages });
```

## Error Handling

```typescript
try {
  const response = await lm.generate({
    model: 'gpt-4',
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
  model: 'gpt-4',
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
    model: 'gpt-4',
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
  instructions: 'You are a helpful assistant.',
  tools: [/* your tools */],
  temperature: 0.7
});

// Run agent
const result = await agent.run('Help me with this task');
console.log(result.output);
```

## Performance Tips

### 1. Choose the Right Model

```typescript
// Fast, cheap tasks
const lm = LM.groq();  // Fastest inference
const response = await lm.generate({
  model: 'mixtral-8x7b-32768',
  messages: [/* ... */]
});

// Complex reasoning tasks
const lm = LM.openai();
const response = await lm.generate({
  model: 'o1-preview',  // Best reasoning
  messages: [/* ... */]
});
```

### 2. Use Lower Temperature for Deterministic Output

```typescript
const response = await lm.generate({
  model: 'gpt-4',
  messages: [/* ... */],
  config: {
    temperature: 0.0  // Most deterministic
  }
});
```

### 3. Optimize Token Usage

```typescript
// ✅ Use system prompt for instructions
const response = await lm.generate({
  model: 'gpt-4',
  systemPrompt: 'Always respond in JSON format.',  // Reusable across requests
  messages: [{ role: 'user', content: 'Get user data' }]
});

// ❌ Repeat instructions in every message
const response = await lm.generate({
  model: 'gpt-4',
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
  model: 'gpt-4',
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
  model: 'claude-3-5-sonnet-20241022',
  messages: conversation
});

console.log(response.text);  // "You told me your name is Alice."
```

### Example 3: Code Generation with Streaming

```typescript
const lm = LM.openai();

console.log('Generating code...\n');

await lm.stream({
  model: 'gpt-4',
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
    email: { type: 'string' },
    phone: { type: 'string' }
  },
  required: ['name']
});

const response = await lm.generate({
  model: 'gpt-4',
  messages: [{
    role: 'user',
    content: 'Extract contact info: John Smith, john@example.com, 555-1234'
  }],
  config: {
    responseFormat: extractionSchema
  }
});

const contact = JSON.parse(response.text);
console.log(contact);
```

### Example 5: Multi-Provider Fallback

```typescript
async function generateWithFallback(prompt: string) {
  const providers = [
    () => LM.openai(),
    () => LM.anthropic(),
    () => LM.groq()
  ];

  for (const createProvider of providers) {
    try {
      const lm = createProvider();
      return await lm.generate({
        model: 'gpt-4',
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

#### Instance Methods

- `generate(request: GenerateRequest): Promise<GenerateResponse>`
- `stream(request: GenerateRequest, callback: (chunk: StreamChunk) => void): Promise<void>`

### Types

```typescript
interface GenerateRequest {
  model: string;
  systemPrompt?: string;
  messages: Message[];
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
  reasoningEffort?: 'minimal' | 'medium' | 'high';
  modalities?: ('text' | 'audio' | 'image')[];
  builtInTools?: ('web_search' | 'code_interpreter' | 'file_search')[];
}
```

## Troubleshooting

### "Could not find native LM bindings"

**Solution:** Make sure the native module is built:

```bash
npm run build:napi
```

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
