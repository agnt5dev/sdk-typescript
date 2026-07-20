# AGNT5 TypeScript SDK

[![CI](https://github.com/agnt5dev/sdk-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/agnt5dev/sdk-typescript/actions/workflows/ci.yml)

Durable AI workflows and agents for TypeScript.

## Features

- ✅ **Durable Functions** - Automatic retry with configurable policies
- ✅ **Checkpointing** - Resume from last successful step on failure
- ✅ **Multi-Runtime** - Works on Node.js, Bun, Deno, and Edge runtimes
- ✅ **Type-Safe** - Full TypeScript support with type inference
- ✅ **Platform Integration** - Native worker and runtime bindings

## Installation

```bash
npm install @agnt5/sdk
# or
yarn add @agnt5/sdk
# or
pnpm add @agnt5/sdk
```

## Quick Start

### Define a Function

```typescript
import { fn } from '@agnt5/sdk';

export const greet = fn('greet').run(async (ctx, name: string) => {
  ctx.logger.info(`Greeting ${name}`);
  return `Hello, ${name}!`;
});
```

### With Retry and Backoff

```typescript
import { fn } from '@agnt5/sdk';

export const processData = fn('process-data')
  .retry({ maxAttempts: 3, initialIntervalMs: 1000 })
  .backoff({ type: 'exponential', multiplier: 2.0 })
  .run(async (ctx, data: DataInput) => {
    // Your processing logic here
    return { processed: true };
  });
```

### With Checkpointing

```typescript
import { fn } from '@agnt5/sdk';

export const dataPipeline = fn('data-pipeline').run(async (ctx, datasetId: string) => {
  // Step 1: Load data (checkpointed)
  const data = await ctx.step('load', () => loadData(datasetId));

  // Step 2: Transform (checkpointed)
  const transformed = await ctx.step('transform', () => transform(data));

  // Step 3: Validate (checkpointed)
  const validated = await ctx.step('validate', () => validate(transformed));

  return { success: true, records: validated.length };
});
```

### Create a Worker

```typescript
import { Worker } from '@agnt5/sdk';
import './functions'; // Import your function definitions

const worker = new Worker('my-service');
await worker.run();
```

## Runtime Support

The SDK automatically detects and adapts to your runtime:

| Runtime | Binding | Performance | Status |
|---------|---------|-------------|---------|
| Node.js | NAPI (native) | ⚡ Fastest | ✅ Supported |
| Bun | NAPI (native) | ⚡ Fastest | ✅ Supported |
| Deno | NAPI (compat) | ⚡ Fastest | ✅ Supported |
| Cloudflare Workers | WASM | 🔥 Fast | Check runtime requirements |
| Vercel Edge | WASM | 🔥 Fast | Check runtime requirements |
| Next.js Edge | WASM | 🔥 Fast | Check runtime requirements |

No configuration needed - the right binding is automatically selected!

## Documentation

- [Overview](./docs/overview.md) - SDK architecture and concepts
- [Function Component](./docs/function.md) - Durable functions API
- [Context API](./docs/context.md) - Execution context capabilities
- [Runtime Support](./docs/runtime-support.md) - Multi-runtime architecture
- [Tool Component](./docs/tool.md) - Agent capabilities
- [Agent Component](./docs/agent.md) - LLM-driven agents
- [Entity Component](./docs/entity.md) - Stateful components
- [Workflow Component](./docs/workflow.md) - Multi-step orchestration

## Development

### Setup

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build:ts

# Run tests
npm test

# Watch mode
npm run dev
```

### Project Structure

```
sdk-typescript/
├── src/               # TypeScript source code
│   ├── function.ts    # Function builder
│   ├── context.ts     # Execution context
│   ├── worker.ts      # Worker implementation
│   ├── types.ts       # TypeScript types
│   └── __tests__/     # Test files
├── native/            # NAPI-RS bindings
├── wasm/              # WASM bindings
├── docs/              # Documentation
└── dist/              # Compiled output
```

## Examples

See the [`examples/`](./examples/) directory for complete working examples:

- `basic-function.ts` - Simple function definition
- `retry-backoff.ts` - Retry and backoff configuration
- `checkpointing.ts` - Multi-step checkpointing
- `worker.ts` - Worker setup

## Execution modes

The SDK supports local execution as well as platform-backed workers through
the native and WASM bindings. Choose the binding and runtime configuration
appropriate for the deployment environment.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

## License

Apache-2.0 - See [LICENSE](LICENSE) for details.

## Resources

- [AGNT5 Documentation](https://agnt5.com/docs)
- [GitHub Repository](https://github.com/agnt5dev/sdk-typescript)
- [Shared SDK Core](https://github.com/agnt5dev/sdk-core)
