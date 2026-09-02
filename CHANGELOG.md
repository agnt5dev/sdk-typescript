# Changelog

All notable changes to the AGNT5 TypeScript SDK are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.0-beta.6] - 2026-09-02

### Fixed

- Preserve the runtime-authored assignment commit offset on lifecycle records
  so append-time lease fencing can bridge projection lag immediately after a
  pull claim.

## [0.8.0-beta.5] - 2026-09-02

### Changed

- Durable activations are now the journal's step boundary records. Under
  `durable_activation_v1` the runtime journals `workflow.step.*`, `lm.*`,
  `tool_call.*`, and `agent.*` from the activation RPCs, so the SDK no longer
  emits its own lifecycle checkpoints or events for durable steps, timers,
  model calls, tools, and delegated child agents. A REPLAY appends nothing.
- `BeginActivationRequest` carries `displayName` and a bounded (64 KiB)
  plaintext `inputData` for the record; failure requests carry the measured
  `latencyMs`; completion usage carries `cachedTokens`. The native binding is
  built against `agnt5-sdk-core` 0.2.4.
- Durable step bodies run with the activation id as the ambient correlation
  id, so nested `function.*` events, logs, and model stream deltas parent to
  the journal record. Delegated child agents use the CHILD activation id as
  their agent correlation id.
- `Tool.invoke` accepts `{ toolCallId, iteration }` record context and exposes
  `usesDurableActivation(ctx)`.
- Eval and scorer helpers read `lm.completed` / `lm.failed` (formerly
  `lm.call.*`); `stepMemoized` also accepts `data.decision === 'replay'`.
- `activation.` was dropped from the immediate-acknowledgement event prefixes
  (never SDK-emitted); the legacy `workflow.step.` path is unchanged.

## [0.8.0-beta.4] - 2026-08-26

### Fixed

- Update the native binding to `agnt5-sdk-core` 0.2.3 so token-auth
  customer-hosted workers configure verified TLS for discovered HTTPS runtime
  endpoints, including coordinator reconnects and engine connections.

## [0.8.0-beta.3] - 2026-08-26

### Added

- Add fetch-based edge-runtime LM providers for OpenAI, Anthropic, Gemini,
  Azure OpenAI, Bedrock, and OpenAI-compatible APIs.

### Changed

- Update the native binding to `agnt5-sdk-core` 0.2.2 so customer-hosted
  workers preserve discovered project authority across reconnects and honor a
  configured `SSL_CERT_FILE` CA bundle without weakening TLS verification.
- Resolve native prerelease packages from the checked-in `npm/` directories
  until publish time, removing the dependency on packages not yet in npm.

### Fixed

- Fall back from unavailable native bindings so Cloudflare Workers can
  construct and invoke module-scope agents, including streaming tool calls.
- Keep optional capture libraries out of the bundle-time dependency graph so
  packed SDK consumers do not need provider libraries they do not use.

## [0.8.0-beta.2] - 2026-08-24

### Fixed

- Preserve `better-sqlite3` alongside the NAPI platform packages in the
  published `optionalDependencies` metadata.
- Fail release packaging before npm publication if a required non-platform
  optional dependency is removed from the generated package manifest.

## [0.8.0-beta.1] - 2026-08-24

### Changed

- Build Linux native packages with NAPI-RS's glibc 2.17 cross-toolchain and
  verify both architectures load on glibc 2.31 before publishing.
- Update the native binding to `agnt5-sdk-core` 0.2.1 so workers prefer the
  Engine checkpoint endpoint when it is available.
- Document Vercel workerless routes as Node.js functions and require Webpack or
  externalized native packages for Next.js 16 builds.

### Fixed

- Restore Vercel Serverless compatibility after the 0.8.0 beta Linux binaries
  accidentally required glibc 2.39.
- Export the concrete `Sandbox` type for `Context.sandbox` so documented
  sandbox calls compile without casts.

## [0.8.0-beta.0] - 2026-08-12

### Added

- Capture installed OpenAI, OpenAI Agents SDK, Vercel AI SDK, and Google ADK
  calls made inside AGNT5 components without application-level instrumentation.
- Emit correlated `agent.*`, `lm.*`, and `tool_call.*` journal events with
  provider, model, token, `source`, and `capture_mode=observed` metadata.
- Export integration controls through the public `@agnt5/sdk/integrations`
  package path.

### Changed

- Auto-enable available capture integrations at worker and workerless startup
  while keeping missing or disabled third-party libraries as no-ops.
- Preserve provider behavior when capture fails and suppress duplicate raw
  OpenAI events inside OpenAI Agents SDK model spans.

## [0.7.0] - 2026-08-08

### Added

- Add the durable activation V1 contract for fenced step, tool, model, and
  delegated-agent execution.
- Add durable workflow sleeps, invocation idempotency keys, replay-safe model
  finals, and required-child recovery.

### Changed

- Build native and WASM bindings against `agnt5-sdk-core` 0.2.0 and enable
  durable activation V1 in default native builds.
- Batch nonterminal lifecycle records while preserving their durable order.

### Fixed

- Fail closed on direct step checkpoints, preserve activation authority and
  stream evidence, avoid eager native loading, and wait for durably detached
  runs to be accepted.

## [0.6.7] - 2026-08-04

### Fixed

- Use the canonical agent session entity key, including the agent name, when
  loading and saving conversation history through the runtime gateway.

## [0.6.6] - 2026-07-31

### Fixed

- Treat explicit workflow, function, tool, and agent lists as authoritative in
  serverless endpoints, including explicit empty lists, while preserving
  registry fallback when lists are omitted.
- Attach function metadata required to resolve explicitly selected handlers.
- Require the workerless signature version header for signed invocations.

## [0.6.5] - 2026-07-30

### Fixed

- Update native and WASM bindings to `agnt5-sdk-core` 0.1.6 so TypeScript
  receives Gemini tool-call parsing and expanded Amazon Bedrock provider
  support.

## [0.6.4] - 2026-07-29

### Fixed

- Stream callback-based `LM` responses, including tool calls, through agent
  message events so Studio renders assistant output immediately.
- Return structured agent terminal output with the final text and tool calls.
- Update native and WASM bindings to `agnt5-sdk-core` 0.1.5.

## [0.6.3] - 2026-07-26

### Added

- Add parallel function execution and deterministic event-emitter coverage.

### Fixed

- Preserve agent model stream ordering, pull completion fencing, and workerless
  lifecycle behavior across concurrent runs.

## [0.6.2] - 2026-07-24

### Fixed

- Current `lm.content_block.*` events use the transient streaming path instead of durable checkpoints.
- N-API and WASM bindings now use `agnt5-sdk-core` 0.1.2 for consistent streaming classification.

## [0.6.1] - 2026-07-20

### Added

- Standalone GitHub-hosted native builds for Linux x64, Linux ARM64, and macOS ARM64.
- npm publishing for the main SDK and its three native platform packages.
- Published `agnt5-sdk-core` crate dependency for the N-API and WASM bindings.

### Fixed

- Native package publishing now ignores unsupported empty platform directories.
- Release builds no longer require their not-yet-published optional platform packages.

[Unreleased]: https://github.com/agnt5dev/sdk-typescript/compare/v0.8.0-beta.4...HEAD
[0.8.0-beta.4]: https://github.com/agnt5dev/sdk-typescript/compare/v0.8.0-beta.3...v0.8.0-beta.4
[0.8.0-beta.3]: https://github.com/agnt5dev/sdk-typescript/compare/v0.8.0-beta.2...v0.8.0-beta.3
[0.8.0-beta.2]: https://github.com/agnt5dev/sdk-typescript/compare/v0.8.0-beta.1...v0.8.0-beta.2
[0.8.0-beta.1]: https://github.com/agnt5dev/sdk-typescript/compare/v0.8.0-beta.0...v0.8.0-beta.1
[0.8.0-beta.0]: https://github.com/agnt5dev/sdk-typescript/compare/v0.7.0...v0.8.0-beta.0
[0.7.0]: https://github.com/agnt5dev/sdk-typescript/compare/v0.6.7...v0.7.0
[0.6.7]: https://github.com/agnt5dev/sdk-typescript/compare/v0.6.6...v0.6.7
[0.6.6]: https://github.com/agnt5dev/sdk-typescript/compare/v0.6.5...v0.6.6
[0.6.5]: https://github.com/agnt5dev/sdk-typescript/compare/v0.6.4...v0.6.5
[0.6.4]: https://github.com/agnt5dev/sdk-typescript/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/agnt5dev/sdk-typescript/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/agnt5dev/sdk-typescript/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/agnt5dev/sdk-typescript/releases/tag/v0.6.1
