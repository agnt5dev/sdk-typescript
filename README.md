# AGNT5 TypeScript SDK

[![CI](https://github.com/agnt5dev/sdk-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/agnt5dev/sdk-typescript/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Build reliable AI agents and durable workflows with TypeScript. The SDK
provides typed components, workflow checkpoints, retries, streaming, tools,
human-in-the-loop coordination, evaluation, and runtime observability.

## Requirements

- Node.js 18 or newer
- An AGNT5 runtime for deployed execution

## Installation

```bash
npm install @agnt5/sdk
```

## Quick start

Define a typed function and start a worker:

```typescript
import { fn, Worker } from '@agnt5/sdk';

const greet = fn('greet').run(async (ctx, name: string) => {
  ctx.logger.info(`Greeting ${name}`);
  return { message: `Hello, ${name}!` };
});

const worker = new Worker('hello-typescript');
await worker.run();
```

Imported functions, workflows, agents, tools, and scorers register with the
worker. See [`examples/simple-worker.ts`](examples/simple-worker.ts) for a
complete entrypoint.

## Durable workflows

Use named steps for operations that should be checkpointed and replayed safely:

```typescript
import { workflow } from '@agnt5/sdk';

export const prepareReport = workflow(
  'prepare-report',
  async (ctx, reportId: string) => {
    const source = await ctx.step('load-source', () => loadSource(reportId));
    const report = await ctx.step('build-report', () => buildReport(source));
    return { reportId, report };
  },
);
```

Keep step names and ordering stable across retries so completed work can be
reused.

## Package entrypoints

| Import | Purpose |
| --- | --- |
| `@agnt5/sdk` | Components, clients, workers, agents, tools, and workflows |
| `@agnt5/sdk/serverless` | Shared serverless adapters |
| `@agnt5/sdk/serverless/node` | Node.js serverless adapter |
| `@agnt5/sdk/serverless/cloudflare` | Cloudflare serverless adapter |
| `@agnt5/sdk/workerless/node` | Node.js workerless HTTP adapter |
| `@agnt5/sdk/workerless/cloudflare` | Cloudflare workerless HTTP adapter |

The default worker uses the published native binding for its supported Node.js
platform. Serverless and workerless entrypoints have separate runtime
requirements; review the relevant example before deploying to an edge runtime.

## Examples and documentation

- [`examples/`](examples/) includes functions, workflows, agents, streaming,
  HITL, MCP, chat, and workerless HTTP examples.
- [`docs/`](docs/) contains the TypeScript SDK guides.
- [AGNT5 documentation](https://agnt5.com/docs) covers platform concepts and
  deployment.

The shared Rust foundation lives in
[`agnt5dev/sdk-core`](https://github.com/agnt5dev/sdk-core). Vendor sandbox
adapters live in
[`agnt5dev/sdk-integrations`](https://github.com/agnt5dev/sdk-integrations).

## Development

```bash
npm ci
npm run build:ts
npm test
```

Native binding development also requires a stable Rust toolchain and a sibling
checkout of `sdk-core`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues according to
[SECURITY.md](SECURITY.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
