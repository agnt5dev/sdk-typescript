# Function Component

## What is a Function?

A **Function** is the most fundamental building block in AGNT5 - a durable, stateless operation that can be invoked remotely and survives failures. Unlike traditional serverless functions that lose state on crashes, AGNT5 functions are designed for resilience with automatic retries, checkpointing, and replay capabilities.

Functions in AGNT5 are:
- **Durable**: Automatically retried on failures with configurable retry policies
- **Stateless**: No persistent state between invocations (use Entities for stateful operations)
- **Isolated**: Each invocation is independent and can be executed concurrently
- **Observable**: Integrated with execution context for tracing and debugging

## Why are Functions Needed?

Functions serve as the atomic units of work in AGNT5, providing several key benefits:

### 1. Fault Tolerance
Functions automatically handle transient failures through built-in retry mechanisms. If a function fails due to network issues, resource unavailability, or temporary errors, AGNT5 will retry the operation according to the configured retry policy.

### 2. Distributed Execution
Functions can be invoked from anywhere - workflows, other functions, or external systems - and executed on any available worker in your infrastructure, enabling true distributed computing.

### 3. Progressive Disclosure
Start with simple functions for basic operations, then compose them into more complex workflows and agents as your application grows. Functions are the foundation that scales from simple tasks to sophisticated multi-step processes.

### 4. Observability
Every function execution is tracked through the execution context, providing built-in tracing, logging, and monitoring capabilities without additional instrumentation.

## How to Use Functions

### Basic Function Definition

The simplest way to define a function is using the `fn()` builder:

```typescript
import { fn, Context } from '@agnt5/sdk';

export const greet = fn('greet').run(async (ctx: Context, name: string) => {
  return `Hello, ${name}!`;
});
```

**Key Points:**
- Functions are async (return `Promise<T>`)
- First parameter is always `ctx: Context` - the execution context
- Remaining parameters are your function's inputs
- Return type should be JSON-serializable

### Function with Configuration

Use the builder pattern to add retry and backoff policies:

```typescript
import { fn, Context } from '@agnt5/sdk';

export const addNumbers = fn('add-numbers')
  .retry({ maxAttempts: 5, initialIntervalMs: 1000, maxIntervalMs: 30000 })
  .backoff({ type: 'exponential', multiplier: 2.0 })
  .run(async (ctx: Context, a: number, b: number) => {
    return a + b;
  });
```

### Configuring Retry Policies

Functions support sophisticated retry configurations:

```typescript
import { fn, Context } from '@agnt5/sdk';

interface PaymentResult {
  status: string;
  amount: number;
  currency: string;
}

export const processPayment = fn('process-payment')
  .retry({
    maxAttempts: 5,
    initialIntervalMs: 1000,
    maxIntervalMs: 30000,
  })
  .backoff({
    type: 'exponential',
    multiplier: 2.0,
  })
  .run(async (ctx: Context, amount: number, currency: string): Promise<PaymentResult> => {
    // Payment processing logic here
    return { status: 'completed', amount, currency };
  });
```

**Retry Policy Options:**
- `maxAttempts`: Maximum number of retry attempts (default: 3)
- `initialIntervalMs`: Initial delay before first retry (default: 1000ms)
- `maxIntervalMs`: Maximum delay between retries (default: 60000ms)

**Backoff Policy Types:**
- `constant`: Fixed delay between retries
- `linear`: Linearly increasing delay
- `exponential`: Exponentially increasing delay (recommended for most cases)

### Using the Context

The `Context` object provides powerful capabilities for durable execution:

#### Checkpointing Steps

For long-running functions, you can checkpoint intermediate results:

```typescript
import { fn, Context } from '@agnt5/sdk';

interface PipelineResult {
  datasetId: string;
  recordsProcessed: number;
  validation: ValidationResult;
}

export const processDataPipeline = fn('process-data-pipeline').run(
  async (ctx: Context, datasetId: string): Promise<PipelineResult> => {
    // Step 1: Load data (checkpointed)
    const data = await ctx.step('load_data', () => loadFromStorage(datasetId));

    // Step 2: Transform data (checkpointed)
    const transformed = await ctx.step('transform', () => applyTransformations(data));

    // Step 3: Validate (checkpointed)
    const validation = await ctx.step('validate', () => validateResults(transformed));

    return {
      datasetId,
      recordsProcessed: transformed.length,
      validation,
    };
  }
);
```

**Why Checkpoints Matter:**
- If the function crashes after step 2, it will resume from step 3 on retry
- No need to reprocess expensive operations
- Ensures exactly-once execution semantics for each step

#### Making HTTP Requests

The context provides a durable HTTP client:

```typescript
import { fn, Context } from '@agnt5/sdk';

interface WeatherData {
  temperature: number;
  conditions: string;
  city: string;
}

export const fetchWeather = fn('fetch-weather').run(
  async (ctx: Context, city: string): Promise<WeatherData> => {
    const response = await ctx.http.get<WeatherData>({
      url: `https://api.weather.com/v1/current?city=${city}`,
      headers: { Authorization: 'Bearer YOUR_TOKEN' },
    });

    return response;
  }
);
```

#### Using LLM Clients

Functions can leverage language models through the context:

```typescript
import { fn, Context } from '@agnt5/sdk';

export const analyzeSentiment = fn('analyze-sentiment').run(
  async (ctx: Context, text: string): Promise<string> => {
    const response = await ctx.llm.generate({
      prompt: [
        { role: 'system', content: 'You are a sentiment analysis expert.' },
        { role: 'user', content: `Analyze the sentiment: ${text}` },
      ],
      model: 'gpt-4',
    });

    return response.text;
  }
);
```

#### Spawning Child Invocations

Functions can spawn other functions asynchronously:

```typescript
import { fn, Context } from '@agnt5/sdk';

interface BatchResult {
  spawnedCount: number;
  childIds: string[];
}

export const processBatch = fn('process-batch').run(
  async (ctx: Context, items: unknown[]): Promise<BatchResult> => {
    // Spawn child invocations for each item
    const childIds: string[] = [];

    for (const item of items) {
      const childId = await ctx.spawn({
        handler: 'process_single_item',
        inputData: { item },
      });
      childIds.push(childId);
    }

    return { spawnedCount: childIds.length, childIds };
  }
);
```

### Complex Input and Output Types

Functions support rich data types with TypeScript:

```typescript
import { fn, Context } from '@agnt5/sdk';

interface Order {
  orderId: string;
  items: Array<{ id: string; quantity: number }>;
  total: number;
  customerEmail: string;
}

interface OrderResult {
  orderId: string;
  status: string;
  confirmationCode: string;
}

export const processOrder = fn('process-order').run(
  async (ctx: Context, order: Order): Promise<OrderResult> => {
    const { orderId, items, customerEmail } = order;

    // Process the order
    const confirmation = await ctx.step(
      'generate_confirmation',
      () => createConfirmation(orderId, items)
    );

    // Send notification
    await ctx.step(
      'send_email',
      () => sendOrderConfirmation(customerEmail, confirmation)
    );

    return {
      orderId,
      status: 'completed',
      confirmationCode: confirmation.code,
    };
  }
);
```

### Error Handling

Functions should handle errors appropriately:

```typescript
import { fn, Context } from '@agnt5/sdk';

interface ApiResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export const safeApiCall = fn('safe-api-call').run(
  async (ctx: Context, endpoint: string): Promise<ApiResult> => {
    try {
      const response = await ctx.http.get({ url: endpoint });
      return { success: true, data: response };
    } catch (e) {
      // Log the error (automatically tracked by context)
      ctx.logger.error(`API call failed: ${e}`);

      // Return error response or re-raise for retry
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
);
```

## Registration and Discovery

Functions are automatically registered when your worker starts:

```typescript
// worker.ts
import { Worker } from '@agnt5/sdk';
import { myFunction } from './functions';

const worker = new Worker('my-service', { runtime: 'standalone' });
await worker.run();
```

The worker discovers all defined functions and registers them with the AGNT5 platform, making them available for invocation.

## Best Practices

### 1. Keep Functions Focused

Each function should do one thing well. Break complex operations into multiple functions composed through workflows.

```typescript
// ✅ Good: Focused functions
export const validateInput = fn('validate-input').run(
  async (ctx: Context, data: Record<string, unknown>) => {
    return isValid(data);
  }
);

export const processData = fn('process-data').run(
  async (ctx: Context, data: Record<string, unknown>) => {
    return transform(data);
  }
);

// ❌ Less ideal: Doing too much in one function
export const validateAndProcess = fn('validate-and-process').run(
  async (ctx: Context, data: Record<string, unknown>) => {
    if (!isValid(data)) {
      throw new Error('Invalid data');
    }
    return transform(data);
  }
);
```

### 2. Use Checkpoints for Expensive Operations

Always checkpoint expensive or non-idempotent operations:

```typescript
export const processLargeFile = fn('process-large-file').run(
  async (ctx: Context, fileUrl: string) => {
    // Checkpoint expensive download
    const content = await ctx.step('download', () => downloadFile(fileUrl));

    // Checkpoint expensive processing
    const result = await ctx.step('process', () => processContent(content));

    return result;
  }
);
```

### 3. Design for Idempotency

Functions may be retried, so ensure they're idempotent:

```typescript
export const updateRecord = fn('update-record').run(
  async (ctx: Context, recordId: string, data: Record<string, unknown>) => {
    // Use upsert instead of insert to handle retries
    return await ctx.step('upsert_record', () => database.upsert(recordId, data));
  }
);
```

### 4. Leverage Async for I/O Operations

Use async/await for I/O-bound operations:

```typescript
export const fetchMultipleSources = fn('fetch-multiple-sources').run(
  async (ctx: Context, sources: string[]) => {
    const results = await Promise.all(
      sources.map(source => ctx.http.get({ url: source }))
    );
    return { sources: sources.length, results };
  }
);
```

### 5. Configure Appropriate Retry Policies

Match retry configuration to operation characteristics:

```typescript
// Short-lived, quick retries for transient network issues
export const quickApiCall = fn('quick-api-call')
  .retry({ maxAttempts: 5, initialIntervalMs: 500 })
  .run(async (ctx: Context, data: string) => {
    return await ctx.http.get({ url: `https://api.example.com/${data}` });
  });

// Longer backoff for rate-limited APIs
export const rateLimitedCall = fn('rate-limited-call')
  .retry({ maxAttempts: 3, initialIntervalMs: 5000 })
  .backoff({ type: 'exponential', multiplier: 3.0 })
  .run(async (ctx: Context, query: string) => {
    return await ctx.http.get({ url: `https://rate-limited-api.com/${query}` });
  });
```

## Function Lifecycle

### 1. Registration
When your worker starts, the `fn()` builder registers the function in the global registry.

### 2. Invocation
Functions can be invoked through:
- **Gateway HTTP/gRPC API**: External invocations
- **Workflows**: Orchestrated execution
- **Other functions**: Function composition
- **Context.spawn()**: Async child invocations

### 3. Execution
The function runs on an available worker with:
- Automatic input deserialization
- Context injection
- Checkpoint replay
- Output serialization

### 4. Completion or Retry
On success, results are returned to the caller. On failure, the retry policy determines whether to retry or fail permanently.

## Advanced Patterns

### Function Composition

```typescript
export const extractData = fn('extract-data').run(
  async (ctx: Context, source: string) => {
    return { data: 'extracted' };
  }
);

export const transformData = fn('transform-data').run(
  async (ctx: Context, data: Record<string, unknown>) => {
    return { data: 'transformed' };
  }
);

export const loadData = fn('load-data').run(
  async (ctx: Context, data: Record<string, unknown>) => {
    return true;
  }
);

export const etlPipeline = fn('etl-pipeline').run(
  async (ctx: Context, source: string) => {
    const extracted = await ctx.step('extract', () => extractData(ctx, source));
    const transformed = await ctx.step('transform', () => transformData(ctx, extracted));
    const loaded = await ctx.step('load', () => loadData(ctx, transformed));
    return { success: loaded };
  }
);
```

### Conditional Execution

```typescript
export const conditionalProcessing = fn('conditional-processing').run(
  async (ctx: Context, data: Record<string, unknown>, mode: string) => {
    let result;

    if (mode === 'fast') {
      result = await ctx.step('fast_process', () => quickProcess(data));
    } else if (mode === 'thorough') {
      result = await ctx.step('thorough_process', () => detailedProcess(data));
    } else {
      throw new Error(`Unknown mode: ${mode}`);
    }

    return result;
  }
);
```

## Debugging and Monitoring

### Logging

```typescript
export const monitoredFunction = fn('monitored-function').run(
  async (ctx: Context, data: string) => {
    ctx.logger.info(`Processing started for data: ${data}`);

    const result = await ctx.step('process', () => processData(data));

    ctx.logger.info(`Processing completed: ${JSON.stringify(result)}`);
    return result;
  }
);
```

### Accessing Invocation Metadata

```typescript
export const introspectiveFunction = fn('introspective-function').run(
  async (ctx: Context, data: string) => {
    return {
      invocationId: ctx.invocationId,
      runId: ctx.runId,
      attempt: ctx.attempt,
      serviceName: ctx.serviceName,
      result: process(data),
    };
  }
);
```

## Type Definitions

```typescript
// Function builder
export interface FunctionBuilder<TInput = unknown, TOutput = unknown> {
  retry(policy: RetryPolicy): FunctionBuilder<TInput, TOutput>;
  backoff(policy: BackoffPolicy): FunctionBuilder<TInput, TOutput>;
  timeout(duration: string): FunctionBuilder<TInput, TOutput>;
  run(
    handler: (ctx: Context, ...args: TInput[]) => Promise<TOutput>
  ): (...args: TInput[]) => Promise<TOutput>;
}

export interface RetryPolicy {
  maxAttempts?: number;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
}

export interface BackoffPolicy {
  type: 'constant' | 'linear' | 'exponential';
  multiplier?: number;
}

// Function definition
export function fn<TInput = unknown, TOutput = unknown>(
  name: string
): FunctionBuilder<TInput, TOutput>;
```

## See Also

- [Entity Component](entity.md) - Stateful components with persistent state
- [Workflow Component](workflow.md) - Multi-step orchestration
- [Context API](context.md) - Detailed context capabilities
- [SDK Reference](../reference/function.md) - Full API documentation
