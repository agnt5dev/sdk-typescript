# AGNT5 TypeScript SDK Overview

## Introduction

The AGNT5 TypeScript SDK provides a comprehensive framework for building durable, fault-tolerant AI applications and workflows. The SDK is designed with a layered architecture where each component builds upon the ones below it, providing progressively higher-level abstractions while maintaining strong durability guarantees.

## Architecture Layers

The SDK is organized into three distinct layers, each serving a specific purpose:

### Layer 1: Foundation

**Context** - The execution environment that provides APIs for all other components.

The Context component is the foundation of all AGNT5 applications. It provides:
- State management across retries and failures
- Checkpointing for expensive operations
- Orchestration APIs for complex workflows
- Observability through logging and metrics
- Access to platform services (LLM, secrets, configuration)

Every component in the SDK receives a Context instance, making it the universal interface for interacting with the AGNT5 platform.

### Layer 2: Durability Primitives

These components provide **durability guarantees** - they survive failures, automatically retry operations, and maintain state across restarts:

**Function** - Durable stateless operations
- Automatic retry with configurable policies
- Multiple backoff strategies (exponential, linear, constant)
- State management through Context
- Checkpointing for idempotent operations
- Function registry for discovery

**Entity** - Durable stateful components
- Persistent state with single-writer consistency
- Method-based API for state operations
- Automatic state persistence and recovery
- Support for both exclusive and shared operations
- Session pattern implementation (conversations, multi-agent coordination)

**Workflow** - Durable multi-step orchestration
- Coordinate multiple functions and entities
- Sequential and parallel execution patterns
- Signal-based coordination
- Human-in-the-loop workflows
- Timer-based scheduling

All Layer 2 components are built on top of Context and provide the core reliability guarantees that make AGNT5 applications production-ready.

### Layer 3: High-Level Abstractions

These components leverage the durability primitives to provide specialized functionality:

**Tool** - Agent capabilities (built on Function)
- Automatic schema extraction using Zod
- Multiple tool types (Function, Hosted, MCP, OpenAPI)
- Confirmation policies for dangerous operations
- Rich metadata with examples and constraints
- Inherits durability from Function primitive

**Agent** - LLM-driven autonomous agents (built on Tool + Entity + Workflow)
- LLM-powered reasoning and planning
- Dynamic tool selection and execution
- Memory integration for long-term knowledge
- Session-aware for conversation context
- Multi-agent coordination patterns
- Streaming support for real-time responses

Layer 3 components don't add new durability guarantees - they build on the reliability of Layer 2 while providing higher-level developer experiences.

## Component Dependencies

```
┌─────────────────────────────────────────────┐
│  Layer 3: High-Level Abstractions           │
│  ┌─────────┐  ┌──────────────────────────┐  │
│  │  Tool   │  │       Agent              │  │
│  │         │◄─┤  (Tool + Entity +       │  │
│  └────┬────┘  │   Workflow)              │  │
│       │       └──────────────────────────┘  │
└───────┼──────────────────────────────────────┘
        │
┌───────┼──────────────────────────────────────┐
│  Layer 2: Durability Primitives              │
│  ┌────▼──────┐  ┌─────────┐  ┌──────────┐   │
│  │ Function  │  │ Entity  │  │ Workflow │   │
│  └────┬──────┘  └────┬────┘  └────┬─────┘   │
│       │              │            │          │
└───────┼──────────────┼────────────┼──────────┘
        │              │            │
        ▼              ▼            ▼
┌─────────────────────────────────────────────┐
│  Layer 1: Foundation                         │
│  ┌──────────────────────────────────────┐   │
│  │           Context                    │   │
│  │  (State, Orchestration, LLM, Obs.)   │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

## Component Overview

### Context (Foundation)

**Purpose**: Execution environment providing APIs for all components

**Key Features**:
- State management (`get`, `set`, `delete`)
- Checkpointing (`step`, `run`)
- Orchestration (`task`, `parallel`, `gather`, `spawn`)
- Coordination (`signal`, `timer`, `sleep`)
- AI Integration (`llm.generate`, `llm.stream`)
- Observability (`logger`, `metrics`, `traceSpan`)
- Configuration (`secrets`, `config`, `headers`)
- Messaging (`sendTo`, `subscribe`)

**Dependencies**: None (foundation layer)

**Status**: Partial implementation (state, checkpointing, logging complete; orchestration/LLM pending)

### Function (Durability Primitive)

**Purpose**: Durable stateless operations with automatic retry

**Key Features**:
- `fn()` builder for defining handlers
- Automatic retry with exponential/linear/constant backoff
- Context injection for state and metadata
- Checkpointing via `ctx.step()` for idempotency
- Function registry for discovery
- Async function support (native Promises)

**Dependencies**: Context

**Status**: ✅ Fully implemented (Phase 1 complete)

**Example**:
```typescript
import { fn, Context } from '@agnt5/sdk';

export const processData = fn('process-data')
  .retry({ maxAttempts: 3, backoff: 'exponential' })
  .run(async (ctx: Context, data: DataInput) => {
    // State persists across retries
    ctx.set('attemptCount', ctx.attempt);

    // Checkpoint expensive operations
    const result = await ctx.step('fetch', () => fetchExternalData(data));

    return { processed: result };
  });
```

### Entity (Durability Primitive)

**Purpose**: Durable stateful components with persistent state

**Key Features**:
- `entity()` function for defining stateful components
- Decorator-based method definitions
- Single-writer consistency per entity instance
- Automatic state persistence and recovery
- Session pattern support (conversations, multi-agent)

**Dependencies**: Context, Function patterns

**Status**: Phase 2 (not yet implemented)

**Example Pattern**:
```typescript
import { entity, Context } from '@agnt5/sdk';

const UserAccount = entity('UserAccount');

@UserAccount.method()
async function deposit(ctx: Context, amount: number): Promise<AccountResult> {
  const balance = ctx.get<number>('balance', 0);
  const newBalance = balance + amount;
  ctx.set('balance', newBalance);
  return { balance: newBalance };
}

// Usage: Each user_id gets isolated state
const account = UserAccount.create('user-123');
const result = await account.deposit(100.0);
```

### Workflow (Durability Primitive)

**Purpose**: Durable multi-step orchestration with coordination

**Key Features**:
- Decorator-based workflow definition
- Sequential and parallel task execution
- Conditional branching and loops
- Signal-based coordination between workflows
- Human-in-the-loop approvals
- Timer-based scheduling

**Dependencies**: Context, Function, Entity

**Status**: Phase 2 (not yet implemented)

**Example Pattern**:
```typescript
import { workflow, Context } from '@agnt5/sdk';

@workflow()
async function orderFulfillment(ctx: Context, orderId: string): Promise<OrderResult> {
  // Sequential steps
  const payment = await ctx.task(processPayment, orderId);

  // Parallel execution
  const [shipping, notification] = await ctx.parallel(
    ctx.task(scheduleShipping, orderId),
    ctx.task(sendConfirmation, orderId)
  );

  // Wait for external signal
  await ctx.signal.wait('order_shipped');

  return { status: 'completed', tracking: shipping };
}
```

### Tool (High-Level Abstraction)

**Purpose**: Agent capabilities with automatic schema extraction

**Key Features**:
- `tool()` builder with Zod schemas
- Multiple tool types (Function, Hosted, MCP, OpenAPI)
- Confirmation policies for dangerous operations
- Automatic type inference from Zod
- Tool composition patterns
- Context access for advanced operations

**Dependencies**: Function (inherits durability)

**Status**: Phase 2 (not yet implemented)

**Example Pattern**:
```typescript
import { tool } from '@agnt5/sdk';
import { z } from 'zod';

export const deleteDatabase = tool({
  name: 'delete_database',
  description: 'Delete a database permanently.',
  parameters: z.object({
    databaseName: z.string().describe('Name of the database to delete'),
  }),
  confirmation: true,
  execute: async ({ databaseName }) => {
    // Schema extracted automatically from Zod
    // Confirmation required before execution
    return { status: 'deleted', database: databaseName };
  },
});
```

### Agent (High-Level Abstraction)

**Purpose**: LLM-driven autonomous agents with reasoning capabilities

**Key Features**:
- LLM-powered reasoning and planning
- Dynamic tool selection and orchestration
- Memory integration for long-term knowledge
- Session-aware for conversation context
- Multi-agent coordination patterns
- Streaming responses for real-time UX
- Agent handoff patterns

**Dependencies**: Tool, Entity (for sessions), Workflow (for orchestration)

**Status**: Phase 2 (not yet implemented)

**Example Pattern**:
```typescript
import { Agent, LanguageModel, Session, Memory } from '@agnt5/sdk';

const session = new Session({ id: 'chat-123', userId: 'user-456' });
const memory = new Memory({ service: vectorMemoryService });
const lm = new LanguageModel();

const agent = new Agent({
  name: 'research-assistant',
  model: lm,
  instructions: 'You are a helpful research assistant.',
  tools: {
    search: searchPapersTool,
    analyze: analyzePaperTool,
    summarize: generateSummaryTool,
  },
  session,
  memory,
});

// Agent autonomously selects and executes tools
const result = await agent.run('Summarize recent work on transformers');
```

## Session Pattern (Entity-Based)

**Important Note**: Session is not a separate component - it's a pattern implemented using Entity.

A Session is simply an Entity with conversation-oriented methods:
- `addMessage()` - Add to conversation history
- `getHistory()` - Retrieve conversation
- `setState()` - Store session state
- Multi-agent coordination through shared entity state

Example:
```typescript
// Session is an Entity pattern
const ConversationSession = entity('Session');

@ConversationSession.method()
async function addMessage(ctx: Context, role: string, content: string): Promise<void> {
  const history = ctx.get<Message[]>('messages', []);
  history.push({ role, content });
  ctx.set('messages', history);
}

const session = ConversationSession.create('chat-123');
await session.addMessage('user', 'Hello!');
```

## Implementation Phases

### Phase 1: Core Contracts (Complete ✅)

**Status**: Released as v0.2.0

**What's Available**:
- Context: State management, checkpointing, logging
- Function: Complete implementation with retry, backoff, registry
- TypeScript-first with full type inference
- Working examples and documentation

**What Developers Can Build**:
- Durable functions with automatic retry
- State management across failures
- Checkpointed operations for idempotency
- Function discovery and registry

**Limitations**:
- In-memory state (not persisted across process restarts)
- In-memory checkpoints
- No platform integration
- No orchestration, LLM, or coordination features

### Phase 2: Platform Integration (Next)

**Focus**: Connect to AGNT5 platform services

**Features**:
- Rust core integration for performance
- gRPC communication with Gateway and Execution Engine
- Event sourcing with Redpanda
- State projections with CockroachDB
- Orchestration APIs (`task`, `parallel`, `gather`, `spawn`)
- LLM integration (`ctx.llm`)
- Signals and timers
- Workflow component
- Tool component (built on durable Functions)
- Agent component (built on Tools + Entity patterns)
- Durable HTTP client
- Metrics and distributed tracing

**Benefits**:
- True durability (state survives process restarts)
- Distributed execution
- Exactly-once semantics
- Production-grade observability

### Phase 3: Advanced Features (Q1 2025)

**Focus**: Entity component and advanced patterns

**Features**:
- Entity component with persistent state
- Single-writer consistency guarantees
- Advanced session patterns
- Production hardening
- Secrets management
- Configuration service integration
- Advanced messaging patterns
- Human-in-the-loop workflows

## Development Principles

### 1. Progressive Disclosure

Start simple, reveal complexity only when needed:
- Basic: `fn()` builder with defaults
- Intermediate: Custom retry policies and backoff
- Advanced: Checkpointing, state management, orchestration

### 2. Type Safety

Leverage TypeScript for:
- Automatic schema extraction (Tools with Zod)
- IDE autocomplete and validation
- Runtime type checking
- Documentation generation

### 3. Developer Experience

Prioritize ease of use:
- Fluent builder APIs (`fn().retry().run()`)
- Clear error messages
- Comprehensive examples
- Detailed documentation

### 4. Reliability First

Durability primitives provide strong guarantees:
- Automatic retry on transient failures
- State persistence across restarts
- Exactly-once execution semantics
- Fault tolerance by default

### 5. Composability

Components work together seamlessly:
- Context is universal interface
- Tools built on Functions
- Agents compose Tools, Entities, Workflows
- Clear dependency hierarchy

## Migration Path

### From Phase 1 to Phase 2

**No Breaking Changes**:
- Existing function definitions work as-is
- State and checkpointing APIs remain the same
- Code continues to work locally

**Opt-In Platform Features**:
- Connect to platform with configuration
- Orchestration APIs become available
- State automatically becomes durable
- Functions can call remote functions

**Incremental Adoption**:
- Mix local and platform-integrated code
- Migrate functions one at a time
- Test with local platform instance

### From Phase 2 to Phase 3

**Additive Changes**:
- Entity component becomes available
- Advanced patterns enabled
- New APIs added to Context
- Existing code continues to work

## Getting Started

### Installation

```bash
npm install @agnt5/sdk
# or
yarn add @agnt5/sdk
# or
pnpm add @agnt5/sdk
```

### Hello World

```typescript
import { fn, Context } from '@agnt5/sdk';

export const greet = fn('greet').run(async (ctx: Context, name: string) => {
  ctx.logger.info(`Greeting ${name}`);
  return `Hello, ${name}!`;
});

// Run locally
const result = await greet('World');
console.log(result); // "Hello, World!"
```

### With Retry and State

```typescript
import { fn, Context } from '@agnt5/sdk';

interface ParsedData {
  parsed: boolean;
  data: unknown;
}

export const fetchData = fn('fetch-data')
  .retry({ maxAttempts: 3, initialIntervalMs: 1000 })
  .backoff({ type: 'exponential', multiplier: 2.0 })
  .run(async (ctx: Context, url: string): Promise<ParsedData> => {
    // Track attempts
    const attempt = ctx.attempt;
    ctx.set('lastAttempt', attempt);

    // Checkpoint expensive operations
    const data = await ctx.step('fetch', () => httpGet(url));
    const parsed = await ctx.step('parse', () => parseJson(data));

    return parsed;
  });
```

## Next Steps

1. **Read Component Docs**: Detailed documentation for each component
   - [Context API](context.md)
   - [Function Component](function.md)
   - [Entity Component](entity.md)
   - [Workflow Component](workflow.md)
   - [Tool Component](tool.md)
   - [Agent Component](agent.md)

2. **Explore Examples**: Working code in `examples/` directory
   - Basic functions
   - Retry policies
   - Function registry
   - (More coming in Phase 2)

3. **Check Status**: Track implementation progress
   - [SDK Status](../../docs/status/sdk-typescript-status.md)

4. **Join Community**: Get help and share feedback
   - GitHub Issues
   - Documentation
   - Examples

## Summary

The AGNT5 TypeScript SDK provides a layered architecture for building reliable AI applications:

- **Layer 1 (Foundation)**: Context provides universal APIs
- **Layer 2 (Durability)**: Function, Entity, Workflow provide fault tolerance
- **Layer 3 (High-Level)**: Tool and Agent provide specialized abstractions

Each layer builds on the one below, with clear dependencies and separation of concerns. Start with Functions (Phase 1), then add platform integration (Phase 2), and finally leverage advanced Entity patterns (Phase 3).

The SDK is designed for progressive disclosure - simple things are simple, complex things are possible.
