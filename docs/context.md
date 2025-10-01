# Context API

## What is Context?

The **Context** (`ctx`) is the execution environment provided to all AGNT5 components (functions, entities, workflows). It provides APIs for orchestration, state management, LLM interactions, signals, timers, and observability.

**Key Capabilities:**
- **Orchestration**: Execute tasks, spawn functions, parallel execution
- **State Management**: Get/set/delete state for entities
- **Coordination**: Signals, timers, human approvals
- **AI Integration**: LLM calls, tool registration
- **Observability**: Logging, metrics, tracing

## Core Orchestration APIs

### `ctx.task()` - Execute a Function

Call a function and wait for the result (workflows only):

```typescript
import { Context } from '@agnt5/sdk';

const result = await ctx.task({
  serviceName: 'analytics',
  handlerName: 'process_data',
  input: { dataset: 'users' }
});
```

### `ctx.parallel()` - Concurrent Execution

Run multiple tasks in parallel (workflows only):

```typescript
// Returns array of results in order
const results = await ctx.parallel([
  ctx.task({ serviceName: 'service1', handlerName: 'handler1' }),
  ctx.task({ serviceName: 'service2', handlerName: 'handler2' }),
  ctx.task({ serviceName: 'service3', handlerName: 'handler3' })
]);
```

### `ctx.gather()` - Named Parallel Results

Like `parallel()` but with object keys (workflows only):

```typescript
const results = await ctx.gather({
  db: ctx.task({ serviceName: 'analytics', handlerName: 'analyze_db' }),
  api: ctx.task({ serviceName: 'analytics', handlerName: 'analyze_api' })
});
// Access: results.db, results.api
```

### `ctx.spawn()` - Async Child Invocation

Spawn a child function without waiting:

```typescript
const handle = ctx.spawn(myFunction, arg1, arg2, { key: 'unique-id' });
// Continue doing other work...
const result = await handle.result();
```

### `ctx.step()` - Checkpointing

Checkpoint expensive operations (functions only):

```typescript
// If function crashes, won't re-execute this step
const data = await ctx.step('load_data', async () => {
  return await expensiveDatabaseQuery();
});
```

## State Management (Entities)

### `ctx.get()` - Get State

Read from entity state:

```typescript
const history = await ctx.get<string[]>('history', []);
```

### `ctx.set()` - Set State

Write to entity state:

```typescript
ctx.set('history', updatedHistory);
```

### `ctx.delete()` - Delete State

Remove key from state:

```typescript
ctx.delete('temporary_data');
```

### `ctx.entity()` - Call Entity Method

Invoke an entity method:

```typescript
const result = await ctx.entity('ChatAgent', 'conversation-123').sendMessage('Hello!');
```

## Coordination APIs

### `ctx.signal()` - Wait for External Event

Pause execution until signal received:

```typescript
const approval = await ctx.signal({
  name: 'manager_approved',
  timeoutMs: 86400000,  // 24 hours
  default: { approved: false }
});
```

### `ctx.signal.emit()` - Send Signal

Send a signal to waiting workflow:

```typescript
await ctx.signal.emit('deployment_ready', {
  version: '1.0.0'
});
```

### `ctx.timer()` - Wait for Delay

Pause for a duration:

```typescript
// Wait 5 seconds
await ctx.timer({ delayMs: 5000 });

// Wait until specific time
await ctx.timer({ cron: '0 0 * * *' });  // Daily at midnight
```

### `ctx.sleep()` - Durable Sleep

Sleep with checkpoint (alternative to `timer()`):

```typescript
await ctx.sleep(30);  // Sleep for 30 seconds
```

### `ctx.human.approval()` - Human-in-the-Loop

Request human approval:

```typescript
const result = await ctx.human.approval({
  name: 'deploy_production',
  payload: { version: '2.0.0' },
  timeout: '30m',
  requiredRoles: ['admin']
});

if (result.decision === 'approved') {
  // Proceed with deployment
}
```

## AI Integration

### `ctx.llm.generate()` - Generate Text or Structured Data

Generate text or structured responses from language models:

```typescript
// Simple text generation
const response = await ctx.llm.generate({
  prompt: 'Explain quantum computing in simple terms',
  model: 'gpt-4o-mini'
});
console.log(response.text);

// Chat-style conversation
const response = await ctx.llm.generate({
  prompt: [
    { role: 'system', content: 'You are a helpful assistant' },
    { role: 'user', content: 'Explain quantum computing' }
  ],
  model: 'gpt-4'
});

// Structured JSON output
const response = await ctx.llm.generate({
  prompt: 'Extract key information from this text: ...',
  responseFormat: 'json',
  model: 'gpt-4o-mini'
});
console.log(response.object);  // Parsed JSON object

// JSON Schema-constrained responses
interface UserProfile {
  name: string;
  age: number;
}

const response = await ctx.llm.generate<UserProfile>({
  prompt: 'Create a user profile',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'integer' }
    },
    required: ['name', 'age']
  },
  model: 'gpt-4o-mini'
});
```

### `ctx.llm.stream()` - Stream Generated Text

Stream responses for real-time output:

```typescript
// Stream text generation
const stream = await ctx.llm.stream({
  prompt: 'Write a long story about AI',
  model: 'gpt-4o'
});

for await (const chunk of stream) {
  process.stdout.write(chunk.text);
}

// Stream with chat messages
const stream = await ctx.llm.stream({
  prompt: [
    { role: 'system', content: 'You are a storyteller' },
    { role: 'user', content: 'Tell me a story' }
  ],
  model: 'gpt-4o'
});

for await (const chunk of stream) {
  if (chunk.text) {
    process.stdout.write(chunk.text);
  }
}
```

### `ctx.tools.register()` - Register Tool

Register a tool for LLM use:

```typescript
const searchTool = ctx.tools.register({
  name: 'web_search',
  handler: performSearch,
  description: 'Search the web for information',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string' }
    }
  }
});
```

## Memory & State

### `ctx.memory.get()` / `set()` / `delete()`

Durable memory operations (alternative to ctx.get/set):

```typescript
// Get value
const data = await ctx.memory.get<ConversationHistory>('conversation_history', []);

// Set value
await ctx.memory.set('conversation_history', updatedData);

// Delete value
await ctx.memory.delete('temporary_cache');
```

### `ctx.memory.append()` - Append to List

Append with automatic size limiting:

```typescript
await ctx.memory.append('messages', newMessage, { limit: 100 });  // Keep last 100 items
```

## Observability

### `ctx.log()` - Structured Logging

Access logger with context:

```typescript
const logger = ctx.log();
logger.info('Processing started', { userId: '123' });
logger.error('Operation failed', { error });
```

### `ctx.metrics()` - Record Metrics

Track custom metrics:

```typescript
const metrics = ctx.metrics();
metrics.increment('requests.count', { service: 'api' });
metrics.observe('latency.ms', 42.5, { endpoint: '/users' });
```

### `ctx.traceSpan()` - Distributed Tracing

Create spans for tracing:

```typescript
const span = ctx.traceSpan();
await span.start('external_api_call', { service: 'payments' }, async () => {
  const result = await callPaymentApi();
  return result;
});
```

## Configuration & Secrets

### `ctx.secrets()` - Access Secrets

Retrieve secrets securely:

```typescript
const secrets = ctx.secrets();
const apiKey = secrets.get('openai_api_key');
const dbPassword = secrets.get('database_password');
```

### `ctx.config()` - Feature Flags

Access configuration:

```typescript
const config = ctx.config();
const enabled = config.get('new_feature_enabled', false);
const variant = config.variant('experiment_group', 'control');
```

### `ctx.headers()` - Request Headers

Access incoming request headers:

```typescript
const headers = ctx.headers();
const userAgent = headers.get('user-agent') ?? 'unknown';
```

## Messaging

### `ctx.sendTo()` - Send Message

Send message to another participant:

```typescript
const messageId = await ctx.sendTo({
  target: 'agent-coordinator',
  message: { status: 'completed', result: data },
  metadata: { priority: 'high' }
});
```

### `ctx.subscribe()` - Subscribe to Messages

Receive messages asynchronously:

```typescript
for await (const message of ctx.subscribe('my-agent')) {
  processMessage(message.payload);
  await message.ack();  // Acknowledge receipt
}
```

## Context Properties

### Execution Metadata

Access execution context:

```typescript
ctx.runId           // Workflow/run identifier
ctx.stepId          // Current step identifier
ctx.attempt         // Retry attempt number
ctx.componentType   // "function", "entity", "workflow"
ctx.objectId        // Entity key (for entities)
ctx.methodName      // Entity method name (for entities)
```

## Common Patterns

### Parallel with Error Handling

```typescript
const results = await ctx.gather({
  task1: ctx.task({ serviceName: 'svc', handlerName: 'task1' }),
  task2: ctx.task({ serviceName: 'svc', handlerName: 'task2' })
});

if (results.task1 && results.task2) {
  // Both succeeded
}
```

### Conditional Signal Waiting

```typescript
if (needsApproval) {
  const approval = await ctx.signal({ name: 'approval_signal', timeoutMs: 60000 });
  if (!approval?.approved) {
    return { status: 'rejected' };
  }
}
```

### LLM with Tool Execution

```typescript
// Register tools
const searchTool = ctx.tools.register({
  name: 'search',
  handler: searchHandler
});
const calcTool = ctx.tools.register({
  name: 'calculator',
  handler: calcHandler
});

// Generate with tools
const response = await ctx.llm.generate({
  prompt: 'What is 25 * 4 and what are the latest news on AI?',
  tools: [searchTool, calcTool],
  model: 'gpt-4o'
});

// Execute tool calls if needed
if (response.toolCalls) {
  for (const toolCall of response.toolCalls) {
    const handler = ctx.tools.handler(toolCall.name);
    const result = await handler(toolCall.arguments);
  }
}
```

### Checkpointed Multi-Step Process

```typescript
import { fn, Context } from '@agnt5/sdk';

export const processPipeline = fn('process-pipeline').run(
  async (ctx: Context, dataId: string) => {
    // Each step is checkpointed
    const raw = await ctx.step('extract', () => extractData(dataId));
    const cleaned = await ctx.step('clean', () => cleanData(raw));
    const result = await ctx.step('analyze', () => analyze(cleaned));
    return result;
  }
);

async function extractData(dataId: string) {
  // Implementation
  return {};
}

async function cleanData(raw: unknown) {
  // Implementation
  return {};
}

async function analyze(cleaned: unknown) {
  // Implementation
  return {};
}
```

## Type Definitions

```typescript
export interface Context {
  // Execution metadata
  readonly runId: string;
  readonly stepId?: string;
  readonly attempt: number;
  readonly componentType: 'function' | 'entity' | 'workflow';
  readonly objectId?: string;
  readonly methodName?: string;

  // State management
  get<T>(key: string, defaultValue?: T): Promise<T | undefined>;
  set<T>(key: string, value: T): void;
  delete(key: string): void;

  // Checkpointing
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;

  // Orchestration
  task<T>(options: TaskOptions): Promise<T>;
  parallel<T>(tasks: Promise<T>[]): Promise<T[]>;
  gather<T extends Record<string, Promise<any>>>(
    tasks: T
  ): Promise<{ [K in keyof T]: Awaited<T[K]> }>;
  spawn<T>(handler: Function, ...args: any[]): SpawnHandle<T>;

  // Coordination
  signal<T>(options: SignalOptions): Promise<T>;
  timer(options: TimerOptions): Promise<void>;
  sleep(seconds: number): Promise<void>;

  // AI Integration
  readonly llm: LLMClient;
  readonly tools: ToolsClient;

  // Memory
  readonly memory: MemoryClient;

  // Observability
  log(): Logger;
  readonly logger: Logger;
  metrics(): MetricsClient;
  traceSpan(): TraceSpan;

  // Configuration
  secrets(): SecretsClient;
  config(): ConfigClient;
  headers(): Map<string, string>;

  // Messaging
  sendTo(options: SendToOptions): Promise<string>;
  subscribe(participantId: string): AsyncIterable<Message>;

  // Entities
  entity(entityType: string, key: string): EntityProxy;

  // Human-in-the-loop
  readonly human: HumanClient;
}

export interface TaskOptions {
  serviceName: string;
  handlerName: string;
  input?: unknown;
}

export interface SignalOptions {
  name: string;
  timeoutMs?: number;
  default?: unknown;
}

export interface TimerOptions {
  delayMs?: number;
  cron?: string;
}

export interface SendToOptions {
  target: string;
  message: unknown;
  metadata?: Record<string, unknown>;
}

export interface SpawnHandle<T> {
  result(): Promise<T>;
}

export interface LLMClient {
  generate<T = string>(options: GenerateOptions): Promise<GenerateResponse<T>>;
  stream(options: StreamOptions): Promise<AsyncIterable<StreamChunk>>;
}

export interface GenerateOptions {
  prompt: string | ChatMessage[];
  model: string;
  responseFormat?: 'text' | 'json';
  schema?: Record<string, unknown>;
  tools?: Tool[];
}

export interface GenerateResponse<T = string> {
  text: string;
  object?: T;
  toolCalls?: ToolCall[];
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamOptions {
  prompt: string | ChatMessage[];
  model: string;
}

export interface StreamChunk {
  text: string;
}

export interface ToolsClient {
  register(options: ToolOptions): Tool;
  handler(name: string): Function;
}

export interface ToolOptions {
  name: string;
  handler: Function;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface Tool {
  name: string;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface MemoryClient {
  get<T>(key: string, defaultValue?: T): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  append<T>(key: string, value: T, options?: AppendOptions): Promise<void>;
}

export interface AppendOptions {
  limit?: number;
}

export interface Logger {
  info(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  debug(message: string, metadata?: Record<string, unknown>): void;
}

export interface MetricsClient {
  increment(name: string, tags?: Record<string, string>): void;
  observe(name: string, value: number, tags?: Record<string, string>): void;
}

export interface TraceSpan {
  start<T>(
    name: string,
    tags: Record<string, unknown>,
    fn: () => Promise<T>
  ): Promise<T>;
}

export interface SecretsClient {
  get(key: string): string | undefined;
}

export interface ConfigClient {
  get<T>(key: string, defaultValue?: T): T;
  variant(experimentName: string, defaultVariant: string): string;
}

export interface Message {
  payload: unknown;
  ack(): Promise<void>;
}

export interface EntityProxy {
  [methodName: string]: (...args: any[]) => Promise<any>;
}

export interface HumanClient {
  approval(options: ApprovalOptions): Promise<ApprovalResult>;
}

export interface ApprovalOptions {
  name: string;
  payload?: unknown;
  timeout?: string;
  requiredRoles?: string[];
}

export interface ApprovalResult {
  decision: 'approved' | 'rejected' | 'timeout';
  approver?: string;
  timestamp?: string;
}
```

## See Also

- [Function Component](function.md) - Using context in functions
- [Entity Component](entity.md) - Using context in entities
- [Workflow Component](workflow.md) - Using context in workflows
