# Entity Component

## What is an Entity?

An **Entity** in AGNT5 is a stateful component identified by a unique key. Entities represent stateful things in your application - AI agents with conversation memory, workflow orchestrators, or any business entity that needs to maintain state across interactions.

**Key Characteristics:**
- **Unique Key**: Each instance has a unique identifier (e.g., `agent-conv-123`)
- **Private State**: Built-in key-value storage per instance
- **Single-Writer**: Only one write operation per key at a time (no race conditions)
- **Durable**: State survives crashes and restarts
- **Scalable**: Different keys execute in parallel

## Why are Entities Needed?

### 1. Automatic Consistency

Entities provide single-writer consistency automatically - no locks or coordination code needed:

```typescript
// Two concurrent calls to increment("counter-1") execute serially
// Final count will be 2, never 1 (no lost updates)
```

### 2. AI Agent & Workflow Modeling

Entities naturally model stateful AI components:

| Entity Type | Key Pattern | Use Case |
|-------------|-------------|----------|
| AI Agent | `agent-{conversation_id}` | Chat history, context, memory |
| Workflow | `workflow-{run_id}` | Step progress, results |
| User Context | `context-{user_id}` | Preferences, personalization |

### 3. State Management & Scalability

Built-in KV storage with horizontal scaling - different keys run in parallel:

```typescript
// Different keys = parallel execution
await ctx.entity("agent", "conv-1").sendMessage(msg);  // Parallel
await ctx.entity("agent", "conv-2").sendMessage(msg);  // Parallel

// Same key = serial execution (consistency guaranteed)
await ctx.entity("agent", "conv-1").sendMessage(msg1);  // Serial
await ctx.entity("agent", "conv-1").sendMessage(msg2);  // Serial
```

## How to Use Entities

> **Note**: This page describes the Entity API. Check the current SDK release notes for availability.

### Basic Entity Definition

```typescript
import { entity, Context } from '@agnt5/sdk';

// Create entity type
const ConversationAgent = entity('ConversationAgent');

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Write method (exclusive access per key)
ConversationAgent.write('send_message', async (ctx: Context, message: string): Promise<{ response: string }> => {
  const history = await ctx.get<ChatMessage[]>('history', []);
  history.push({ role: 'user', content: message });

  const response = await callLlm(history);
  history.push({ role: 'assistant', content: response });

  ctx.set('history', history);
  return { response };
});

// Shared method (read-only, concurrent)
ConversationAgent.shared('get_history', async (ctx: Context): Promise<ChatMessage[]> => {
  return await ctx.get<ChatMessage[]>('history', []);
});

// Usage from a function
import { fn } from '@agnt5/sdk';

export const chat = fn('chat').run(
  async (ctx: Context, convId: string, msg: string) => {
    return await ctx.entity('ConversationAgent', convId).send_message(msg);
  }
);

async function callLlm(history: ChatMessage[]): Promise<string> {
  // LLM call implementation
  return 'AI response';
}
```

**Key APIs:**
- `entity("name")`: Create entity type
- `EntityType.write(name, handler)`: Write method (exclusive per key)
- `EntityType.shared(name, handler)`: Shared method (read-only, concurrent)
- `ctx.get<T>(key, default)` / `ctx.set(key, value)` / `ctx.delete(key)`: State operations
- `ctx.entity(type, key).method()`: Call entity from function

### Example: Research Agent

```typescript
import { entity, Context } from '@agnt5/sdk';

interface Finding {
  content: string;
  source: string;
}

const ResearchAgent = entity('ResearchAgent');

ResearchAgent.write('start_research', async (ctx: Context, topic: string): Promise<{ status: string }> => {
  ctx.set('topic', topic);
  ctx.set('findings', []);
  ctx.set('status', 'in_progress');
  return { status: 'started' };
});

ResearchAgent.write('add_finding', async (ctx: Context, finding: string, source: string): Promise<{ count: number }> => {
  const findings = await ctx.get<Finding[]>('findings', []);
  findings.push({ content: finding, source });
  ctx.set('findings', findings);
  return { count: findings.length };
});

ResearchAgent.write('synthesize', async (ctx: Context): Promise<{ summary: string }> => {
  const findings = await ctx.get<Finding[]>('findings', []);
  const summary = await generateSummary(findings);
  ctx.set('summary', summary);
  ctx.set('status', 'completed');
  return { summary };
});

ResearchAgent.shared('get_progress', async (ctx: Context): Promise<{ status: string; findings: number }> => {
  const status = await ctx.get<string>('status');
  const findings = await ctx.get<Finding[]>('findings', []);
  return {
    status: status ?? 'unknown',
    findings: findings.length
  };
});

async function generateSummary(findings: Finding[]): Promise<string> {
  // Summary generation implementation
  return 'Summary of findings';
}
```

## Common Patterns

### Conversational AI Agent

```typescript
import { entity, Context } from '@agnt5/sdk';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const ChatAgent = entity('ChatAgent');

ChatAgent.write('send_message', async (ctx: Context, message: string): Promise<{ response: string }> => {
  let history = await ctx.get<ChatMessage[]>('history', []);
  history.push({ role: 'user', content: message });

  const response = await ctx.llm.generate({
    prompt: history,
    model: 'gpt-4'
  });
  history.push({ role: 'assistant', content: response.text });

  // Keep last 20 messages
  if (history.length > 20) {
    history = history.slice(-20);
  }

  ctx.set('history', history);
  return { response: response.text };
});

ChatAgent.shared('get_history', async (ctx: Context): Promise<ChatMessage[]> => {
  return await ctx.get<ChatMessage[]>('history', []);
});
```

### Workflow Orchestrator

```typescript
import { entity, Context } from '@agnt5/sdk';

interface WorkflowStep {
  name: string;
  params: Record<string, unknown>;
}

interface StepResult {
  stepName: string;
  output: unknown;
}

const WorkflowOrchestrator = entity('WorkflowOrchestrator');

WorkflowOrchestrator.write('start', async (ctx: Context, steps: WorkflowStep[]): Promise<{ status: string }> => {
  ctx.set('steps', steps);
  ctx.set('current_step', 0);
  ctx.set('results', []);
  return { status: 'started' };
});

WorkflowOrchestrator.write('complete_step', async (ctx: Context, result: StepResult): Promise<{ completed: number }> => {
  const results = await ctx.get<StepResult[]>('results', []);
  results.push(result);
  ctx.set('results', results);
  ctx.set('current_step', results.length);
  return { completed: results.length };
});

WorkflowOrchestrator.shared('get_progress', async (ctx: Context): Promise<{ current_step: number; total_steps: number }> => {
  const currentStep = await ctx.get<number>('current_step', 0);
  const steps = await ctx.get<WorkflowStep[]>('steps', []);
  return {
    current_step: currentStep,
    total_steps: steps.length
  };
});
```

## Best Practices

### 1. Choose Stable, Meaningful Keys

Use unique, stable keys that identify your entity:

```typescript
// ✅ Good
"agent-conv-{conv_id}"
"workflow-{run_id}"
"user-{user_id}"

// ❌ Avoid
"abc123"  // Not descriptive
"user-{timestamp}"  // Changes every time
```

### 2. Use Shared for Reads

For read-only operations, use `EntityType.shared()` to enable concurrent access:

```typescript
ChatAgent.shared('get_history', async (ctx: Context): Promise<ChatMessage[]> => {
  return await ctx.get<ChatMessage[]>('history', []);  // Multiple reads can run in parallel
});
```

### 3. Design for Concurrency

Different keys run in parallel, same keys serialize:

```typescript
// Different keys = parallel (scales)
await ctx.entity('agent', 'conv-1').send_message(msg);  // Parallel
await ctx.entity('agent', 'conv-2').send_message(msg);  // Parallel

// Same key = serial (consistent)
await ctx.entity('agent', 'conv-1').send_message(msg1);  // Serial
await ctx.entity('agent', 'conv-1').send_message(msg2);  // Serial

// Choose granularity wisely - one entity per conversation, not global
```

## Architecture

Entities use event sourcing for durability and single-writer consistency:

1. Each `ctx.set()` generates an event logged to Redpanda
2. State projected for querying
3. Runtime serializes write handlers per key (queue per key)
4. Shared handlers can run concurrently for the same key
5. Different keys execute in parallel across workers

## Comparison with Functions

| Aspect | Functions | Entities |
|--------|-----------|----------|
| State | Stateless | Stateful (KV store) |
| Identity | No identity | Unique key per instance |
| Concurrency | Parallel by default | Serial per key, parallel across keys |
| Consistency | No consistency needed | Single-writer guarantee |
| Use Case | Transformations, API calls | Stateful AI agents, workflow state |
| Example | `processPayment()` | Conversation agent, research task |

**When to use Functions:**
- Stateless operations
- Independent requests
- Transformations, ETL

**When to use Entities:**
- Stateful AI agents
- Workflow orchestrators
- User context and personalization

## See Also

- [Function Component](function.md) - Stateless operations
- [Workflow Component](workflow.md) - Multi-step orchestration
- [Context API](context.md) - Entity context and state operations
- [Architecture: Entity Persistence (ADR-003)](../architecture/decisions/003-virtual-object-persistence.md)
