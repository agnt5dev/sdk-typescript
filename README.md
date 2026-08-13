# AGNT5 TypeScript SDK

[![CI](https://github.com/agnt5dev/agnt5/actions/workflows/runtime-ci.yml/badge.svg)](https://github.com/agnt5dev/agnt5/actions/workflows/runtime-ci.yml)
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
| `@agnt5/sdk/integrations` | Third-party OpenAI, Agents SDK, Vercel AI SDK, and Google ADK capture |
| `@agnt5/sdk/serverless` | Shared serverless adapters |
| `@agnt5/sdk/serverless/node` | Node.js serverless adapter |
| `@agnt5/sdk/serverless/cloudflare` | Cloudflare serverless adapter |
| `@agnt5/sdk/workerless/node` | Node.js workerless HTTP adapter |
| `@agnt5/sdk/workerless/cloudflare` | Cloudflare workerless HTTP adapter |

The default worker uses the published native binding for its supported Node.js
platform. Serverless and workerless entrypoints have separate runtime
requirements; review the relevant example before deploying to an edge runtime.

## Third-party capture

Persistent workers automatically observe supported third-party libraries when
they are installed by the application. The integrations are soft-loaded; the
SDK does not install or bundle those libraries as runtime dependencies. Set
`AGNT5_CAPTURE=off` to disable all capture, or use
`AGNT5_CAPTURE_OPENAI`, `AGNT5_CAPTURE_OPENAI_AGENTS`,
`AGNT5_CAPTURE_VERCEL_AI`, and `AGNT5_CAPTURE_GOOGLE_ADK` as per-library
switches (`off`, `0`, `false`, and `no` disable a switch).

Captured lifecycle events carry string provenance metadata: `source`
identifies the integration (`openai`, `openai_agents`, `vercel_ai`, or
`google_adk`) and `capture_mode=observed` distinguishes best-effort third-party
observation from explicitly tagged native SDK events (`capture_mode=native`).
Google ADK capture supports `@google/adk` 1.0.0 and newer; legacy 0.x releases
are intentionally unsupported.

Vercel AI SDK 7+ is captured through its public global telemetry registry.
Applications on earlier AI SDK versions can either enable the library's
`experimental_telemetry` option with an existing OpenTelemetry provider, or
use the explicit wrapper:

```typescript
import * as ai from 'ai';
import { wrapAISDK } from '@agnt5/sdk/integrations';

const { generateText, streamText } = wrapAISDK(ai);
```

`JournalSpanProcessor` is also exported for applications that construct their
own OpenTelemetry tracer provider. The processor and wrapper emit only when a
call runs inside an AGNT5 component context, and capture failures never change
the provider call's result.

The workerless/serverless entrypoint invokes the same auto-enable hook for API
parity, but it does not establish AsyncLocalStorage execution context today.
Third-party capture therefore remains a no-op on that path until workerless
context propagation is implemented.

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
