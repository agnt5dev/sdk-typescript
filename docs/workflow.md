# Workflow Component

## What is a Workflow?

A **Workflow** in AGNT5 is a durable, multi-step orchestration that coordinates functions, entities, and external signals. Workflows are written as async TypeScript functions using natural control flow - the platform handles durability and fault tolerance automatically.

**Key Characteristics:**
- **Natural Code**: Write workflows like regular async functions
- **Durable**: Survives failures and resumes from the last completed step
- **Flexible**: Use if/else, loops, and any TypeScript logic
- **Stateful**: Maintains workflow state across steps and restarts
- **Coordinated**: Built-in parallel, sequential, and signal primitives

## Why are Workflows Needed?

### 1. Multi-Step Coordination

Coordinate multiple operations with automatic fault tolerance:

```typescript
// If any step fails, workflow automatically retries
// State is preserved between steps
// No manual progress tracking needed
```

### 2. Long-Running Processes

Durable execution for processes that take time:

| Use Case | Example Steps | Duration |
|----------|---------------|----------|
| AI Research | Search → Analyze → Synthesize | Minutes to hours |
| Order Processing | Validate → Payment → Fulfillment | Hours to days |
| Data Pipeline | Extract → Transform → Load | Minutes to hours |

### 3. Human-in-the-Loop

Wait for external events without losing state:

```typescript
// Workflow pauses for approval signal
// State preserved while waiting (hours or days)
// Automatically resumes when signal received
```

## How to Use Workflows

> **Note**: Workflows are currently in active development. The API shown represents the planned design.

### Basic Workflow Definition

```typescript
import { workflow, WorkflowContext } from '@agnt5/sdk';

interface OrderInput {
  orderId: string;
}

interface OrderResult {
  status: string;
}

const processOrder = workflow(async (ctx: WorkflowContext, input: OrderInput): Promise<OrderResult> => {
  // Validate order
  const order = await ctx.task({
    serviceName: 'orders',
    handlerName: 'validate',
    input: { orderId: input.orderId }
  });

  // Process payment
  const payment = await ctx.task({
    serviceName: 'payments',
    handlerName: 'charge',
    input: { amount: order.total }
  });

  // Fulfill order
  await ctx.task({
    serviceName: 'fulfillment',
    handlerName: 'ship',
    input: { orderId: input.orderId }
  });

  return { status: 'completed' };
});
```

**Key Components:**
- `workflow()`: Function to register workflow
- `ctx.task()`: Execute a function (see [Context API](context.md#ctxtask---execute-a-function))
- `await`: Sequential execution (waits for completion)
- Regular TypeScript: Use if/else, loops, variables

**Context APIs for Workflows:**

Workflows use Context APIs for orchestration. For complete API documentation, see [Context API](context.md).

- `ctx.task()` - Execute a function
- `ctx.parallel()` - Run tasks concurrently
- `ctx.gather()` - Parallel with named results
- `ctx.signal()` - Wait for external events
- `ctx.timer()` - Delays and scheduling

### Example: AI Research Workflow

```typescript
import { workflow, WorkflowContext } from '@agnt5/sdk';

interface ResearchInput {
  topic: string;
}

interface ResearchResult {
  status: string;
  result?: any;
}

const aiResearch = workflow(async (ctx: WorkflowContext, input: ResearchInput): Promise<ResearchResult> => {
  // Initialize research
  await ctx.task({
    serviceName: 'research',
    handlerName: 'start_research',
    input: { topic: input.topic }
  });

  // Search in parallel
  const [papers, web] = await ctx.parallel(
    ctx.task({ serviceName: 'research', handlerName: 'search_academic' }),
    ctx.task({ serviceName: 'research', handlerName: 'search_web' })
  );

  // Synthesize results
  const summary = await ctx.task({
    serviceName: 'research',
    handlerName: 'synthesize',
    input: { papers, web }
  });

  // Wait for human review
  const approved = await ctx.signal.wait('research_approved', {
    timeoutMs: 3600000  // 1 hour
  });

  if (approved?.approved) {
    // Publish results
    const result = await ctx.task({
      serviceName: 'research',
      handlerName: 'publish',
      input: { summary }
    });
    return { status: 'published', result };
  } else {
    return { status: 'cancelled' };
  }
});
```

## Common Patterns

### Sequential Processing

```typescript
import { workflow, WorkflowContext } from '@agnt5/sdk';

interface PipelineInput {
  dataset: string;
}

const dataPipeline = workflow(async (ctx: WorkflowContext, input: PipelineInput) => {
  // Each step runs after the previous completes
  const data = await ctx.task({
    serviceName: 'etl',
    handlerName: 'extract',
    input: { dataset: input.dataset }
  });

  const transformed = await ctx.task({
    serviceName: 'etl',
    handlerName: 'transform',
    input: { data }
  });

  const result = await ctx.task({
    serviceName: 'etl',
    handlerName: 'load',
    input: { data: transformed }
  });

  return result;
});
```

### Parallel Execution

```typescript
import { workflow, WorkflowContext } from '@agnt5/sdk';

interface AnalysisInput {
  query: string;
}

const multiSourceAnalysis = workflow(async (ctx: WorkflowContext, input: AnalysisInput) => {
  // Initialize
  await ctx.task({
    serviceName: 'analytics',
    handlerName: 'setup',
    input: { query: input.query }
  });

  // Analyze multiple sources in parallel
  const results = await ctx.gather({
    db: ctx.task({ serviceName: 'analytics', handlerName: 'analyze_db' }),
    logs: ctx.task({ serviceName: 'analytics', handlerName: 'analyze_logs' }),
    api: ctx.task({ serviceName: 'analytics', handlerName: 'analyze_api' })
  });

  // Aggregate results
  const final = await ctx.task({
    serviceName: 'analytics',
    handlerName: 'combine',
    input: results
  });

  return final;
});
```

### Conditional Logic

```typescript
import { workflow, WorkflowContext } from '@agnt5/sdk';

interface DeploymentInput {
  version: string;
}

interface DeploymentResult {
  status: string;
  result?: any;
  reason?: string;
}

const conditionalDeployment = workflow(async (ctx: WorkflowContext, input: DeploymentInput): Promise<DeploymentResult> => {
  // Build and test
  const build = await ctx.task({
    serviceName: 'ci',
    handlerName: 'build',
    input: { version: input.version }
  });

  const tests = await ctx.task({
    serviceName: 'ci',
    handlerName: 'test',
    input: { buildId: build.id }
  });

  if (tests.passed) {
    // Deploy to production
    const result = await ctx.task({
      serviceName: 'ci',
      handlerName: 'deploy',
      input: { buildId: build.id }
    });
    return { status: 'deployed', result };
  } else {
    // Rollback
    await ctx.task({
      serviceName: 'ci',
      handlerName: 'rollback',
      input: { buildId: build.id }
    });
    return { status: 'failed', reason: 'tests failed' };
  }
});
```

### Retry with Backoff

```typescript
import { workflow, WorkflowContext } from '@agnt5/sdk';

interface JobInput {
  jobId: string;
}

const processWithRetry = workflow(async (ctx: WorkflowContext, input: JobInput) => {
  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await ctx.task({
        serviceName: 'jobs',
        handlerName: 'process',
        input: { jobId: input.jobId }
      });
      return result;
    } catch (e) {
      if (attempt < maxRetries - 1) {
        // Exponential backoff: 1s, 2s, 4s
        const delay = 1000 * Math.pow(2, attempt);
        await ctx.timer({ delayMs: delay });
      } else {
        return {
          status: 'failed',
          error: e instanceof Error ? e.message : String(e)
        };
      }
    }
  }
});
```

### Human Approval with Timeout

```typescript
import { workflow, WorkflowContext } from '@agnt5/sdk';

interface ApprovalInput {
  version: string;
}

interface ApprovalResult {
  status: string;
  result?: any;
  reason?: string;
}

const deployWithApproval = workflow(async (ctx: WorkflowContext, input: ApprovalInput): Promise<ApprovalResult> => {
  // Build and test
  const build = await ctx.task({
    serviceName: 'ci',
    handlerName: 'build',
    input: { version: input.version }
  });

  const tests = await ctx.task({
    serviceName: 'ci',
    handlerName: 'test',
    input: { buildId: build.id }
  });

  if (!tests.passed) {
    return { status: 'failed', reason: 'tests failed' };
  }

  // Wait for approval with 30-minute timeout
  const approval = await ctx.signal.wait('deploy_approved', {
    timeoutMs: 1800000,
    default: { approved: false }
  });

  if (approval.approved) {
    const result = await ctx.task({
      serviceName: 'ci',
      handlerName: 'deploy',
      input: { buildId: build.id }
    });
    return { status: 'deployed', result };
  } else {
    return { status: 'cancelled', reason: 'no approval' };
  }
});
```

## Best Practices

### 1. Keep Workflows Simple

Workflows orchestrate - complex logic belongs in functions:

```typescript
// ✓ Good - workflow orchestrates
const processData = workflow(async (ctx: WorkflowContext, input: { dataId: string }) => {
  const data = await ctx.task({
    serviceName: 'etl',
    handlerName: 'extract',
    input: { id: input.dataId }
  });

  const result = await ctx.task({
    serviceName: 'etl',
    handlerName: 'transform',
    input: { data }
  });

  return result;
});

// ✗ Avoid - complex logic in workflow
const processData = workflow(async (ctx: WorkflowContext, input: { dataId: string }) => {
  const data = await ctx.task({
    serviceName: 'etl',
    handlerName: 'extract',
    input: { id: input.dataId }
  });

  // Don't do heavy computation here
  const transformed = data.map(x => complexCalculation(x));
  return transformed;
});
```

### 2. Use Parallel for Independent Tasks

Run independent tasks concurrently:

```typescript
// These tasks don't depend on each other - run in parallel
const results = await ctx.parallel(
  ctx.task({ serviceName: 'service1', handlerName: 'analyze_data' }),
  ctx.task({ serviceName: 'service2', handlerName: 'fetch_metadata' }),
  ctx.task({ serviceName: 'service3', handlerName: 'validate_schema' })
);
```

### 3. Handle Errors Appropriately

Use try/catch for error handling:

```typescript
const safeProcessing = workflow(async (ctx: WorkflowContext, input: { jobId: string }) => {
  try {
    const result = await ctx.task({
      serviceName: 'jobs',
      handlerName: 'process',
      input: { jobId: input.jobId }
    });
    return { status: 'success', result };
  } catch (e) {
    // Log error and return gracefully
    await ctx.task({
      serviceName: 'logs',
      handlerName: 'log_error',
      input: { error: e instanceof Error ? e.message : String(e) }
    });
    return {
      status: 'error',
      message: e instanceof Error ? e.message : String(e)
    };
  }
});
```

### 4. Pass Data Between Steps

Use return values to pass data:

```typescript
const dataFlow = workflow(async (ctx: WorkflowContext, inputData: Record<string, any>) => {
  // Step 1 produces data
  const step1Result = await ctx.task({
    serviceName: 'svc',
    handlerName: 'step1',
    input: inputData
  });

  // Step 2 uses step1's output
  const step2Result = await ctx.task({
    serviceName: 'svc',
    handlerName: 'step2',
    input: step1Result
  });

  // Step 3 uses step2's output
  const final = await ctx.task({
    serviceName: 'svc',
    handlerName: 'step3',
    input: step2Result
  });

  return final;
});
```

## Architecture

Workflows are executed by the Orchestration Plane:

1. Workflow registered with `workflow()` function
2. Triggered via Gateway API with input parameters
3. Orchestrator executes workflow step-by-step
4. Each `await` checkpoints state to Redpanda
5. On failure, workflow resumes from last checkpoint
6. Parallel tasks distributed across workers
7. Signals and timers managed by orchestrator

## Comparison with Functions and Entities

| Aspect | Functions | Entities | Workflows |
|--------|-----------|----------|-----------|
| Purpose | Single operation | Stateful object | Multi-step orchestration |
| State | Stateless | Keyed state | Workflow state |
| Execution | One invocation | Method calls | Multiple coordinated steps |
| Duration | Seconds | Long-lived | Minutes to days |
| Control Flow | Linear | Event-driven | Sequential + parallel |
| Use Case | Transform data | Chat agent | Order processing pipeline |

**When to use Functions:**
- Single, focused operation
- Quick execution (< 1 minute)
- Stateless transformations

**When to use Entities:**
- Stateful business object
- Multiple operations on same state
- Single-writer consistency needed

**When to use Workflows:**
- Multi-step processes
- Coordination across services
- Long-running operations (minutes to days)
- Human-in-the-loop scenarios

## See Also

- [Function Component](function.md) - Building blocks for workflow steps
- [Entity Component](entity.md) - Stateful components in workflows
- [Context API](context.md) - Workflow execution context
