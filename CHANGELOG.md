# Changelog

All notable changes to the AGNT5 TypeScript SDK are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `MCPServer.addView(name, { html } | { path })` (AGNT5-1569): ship your own MCP App view with a hosted server and show it for a tool's results in clients that render MCP Apps (ChatGPT, Claude, Cursor, VS Code). A view is one self-contained HTML file (for example built with Vite and `vite-plugin-singlefile`); `path` takes a path or a file URL and is read when the view is added. `addView` returns an `MCPView` (`name`, `sha256`, `size`); pass it, or its name, as `view` to `addFunction`, `addWorkflow` or `addAgent`. Any mode can show a view, `sync` tools too, and it replaces the run card for that tool. The view gets the tool's `structuredContent` and text; a call that hands off gives it the run handle in `_meta["com.agnt5/run"]`, and it can poll `get_run` through the host. Clients without MCP Apps still read the text. Up to 2 MB per view (`MCP_MAX_VIEW_BYTES`; a larger file is refused before it is read). Views travel in the worker's registration, so the views of all the servers a worker publishes may take up to 3 MB of it (`MCP_MAX_VIEWS_BYTES`), measured JSON-escaped as they travel (`viewRegistrationBytes`); `addView` holds one server to that, and a worker past it refuses to start, naming each view's size. View names follow the server-name rule, and `run` and `none` are reserved. A missing file, an oversized bundle, or a `view` naming a view the server doesn't have throws where it is written. The bundle travels in the server's definition (`views[].html`) with its SHA-256; needs a control plane and runtime with custom views, and older control planes refuse servers that publish one.
- `ctx.progress(progress, { total?, message? })` in functions and workflows (AGNT5-1569). It writes a `progress.update` record to the run's journal: Studio and `get_run` show the latest report, the AGNT5 run card draws a bar when `total` is known, and an MCP client that sent a progress token on the tool call hears each report as `notifications/progress`. It never blocks and is cheap to call in a loop: each run writes at most one report a second, always the latest, appended at once rather than held until the run completes, and the latest report is written before the run finishes. Progress never goes backwards: within an execution a report below the last one is dropped, and one with the same figure goes out only when its message or total changed; across executions of a run (a retry, a resumed workflow) the MCP edge and `get_run` ignore a report below the run's last figure. A `progress` or `total` that isn't a number, or a `message` that isn't a string, throws `TypeError`; a value that isn't finite or a `total` that isn't positive throws `RangeError`. Locally, workerless and in entity methods a report is checked, then dropped. `Context` gains a required `progress` method, so a hand-written `Context` implementation needs one. Reports reach MCP clients on runtimes with the matching MCP edge.

## [0.10.10] - 2026-10-05

### Added

- `view` on the options of `MCPServer.addFunction`, `addWorkflow` and `addAgent` (AGNT5-1571). Hosted `auto` and `background` tools now show an AGNT5 run card in clients that render MCP Apps (ChatGPT, Claude, Cursor, VS Code), with live status, steps, progress, output, **Open in AGNT5** and **Cancel run**. `view: null` turns the card off for a tool and publishes `"view": "none"`; the default (`MCP_RUN_VIEW`) publishes nothing, so definitions are unchanged. Text-only clients still get the run handle as text. Needs a runtime with the run view; older control planes reject `"view": "none"`.

## [0.10.9] - 2026-10-05

### Removed

- **Breaking:** `MCPServer.runHTTP()` is gone (AGNT5-1569). It answered single JSON-RPC POSTs only (no `GET` stream, sessions or SSE), so it wasn't a compliant Streamable HTTP server. Publish tools with `addFunction`, `addWorkflow` or `addAgent` and AGNT5 serves them over Streamable HTTP at `/mcp/{project}/{env}/{server}`; use `runStdio()` to serve a server locally.

### Fixed

- `MCPServer.runStdio()` follows JSON-RPC 2.0 and MCP (AGNT5-1569). It no longer replies to notifications (any message without an `id`, such as `notifications/initialized`) or to responses from the client. An unknown method is `-32601`; an unknown tool or prompt, `params` or `arguments` that aren't an object, or a missing tool name is `-32602`; an unknown resource is `-32002`; a message without `"jsonrpc": "2.0"`, a method or a string/integer `id` is `-32600`; a line that isn't JSON is `-32700` instead of stopping the server. All of these were `-32603`, and a request without `jsonrpc` was served. A tool that throws now returns a result with `isError: true` and the error text, as hosted servers do, so the model can read it; it was a `-32603` protocol error. `ping` returns `{}`. `dispatch()` returns `undefined` for messages that get no reply, and `MCPServerError` takes a JSON-RPC `code`.

### Added

- `ctx.caller` (AGNT5-1569): who called the run through a hosted MCP server, as a frozen `Caller` with `server`, `tool`, `subject` (an AGNT5 user id for OAuth, `service_key:{id}` for an API key), `authMethod` (`oauth` or `api_key`) and `client` (the OAuth client id or the client's User-Agent). It is `undefined` when the run wasn't started by an MCP tool call. Functions and workflows get it on worker and workerless runs. It reads the `trigger_type=mcp` and `mcp.*` keys the runtime stamps on the run; no token reaches the run. `callerFromMetadata(metadata)` is exported for custom contexts.

- Publish an `MCPServer` with the deployment, as the Python SDK does (AGNT5-1569). Tools added with `addFunction`, `addWorkflow` or `addAgent(name, component, { title, description, mode, visibility, annotations })` are served at `/mcp/{project}/{env}/{server}`, each call running as a durable run. The worker registers each server that publishes a tool as an `mcp` component whose definition follows contract v1 (`definition()`); a server name the platform will refuse (it is a URL segment: lowercase letters, digits, `-`, `_`) is logged as an error at startup. Tool names, modes (`sync`, `auto`, `background`), visibility (`model`, `app`) and annotations are checked where they are written, and `get_run`/`cancel_run` are reserved. Tools carry full JSON Schema 2020-12 input and output schemas (defaults, `$defs`, `anyOf` and `additionalProperties` are kept; Zod 4 schemas are converted) and explicit hints (`readOnlyHint` defaults to `false`). A published agent is served without a `registerAgents` call.
- `new MCPServer('support', { title, instructions })`. The options-object form still works, and `name` and `version` now default to the id and `0.1.0`.
- `fn(name).description(text)` and a `description` workflow option, used as the description of an MCP tool that publishes them.
- `toJsonSchemaDocument(schema, io)` converts a Zod, TypeBox or JSON Schema to a JSON Schema 2020-12 document. Function, workflow and tool registration use it for Zod schemas, which were registered as Zod's internals.

## [0.10.8] - 2026-10-04

### Fixed

- The built-in `correctness` judge no longer marks right answers down for explaining them. Its rubric asked whether the output "matches the expected output" and gave partial credit otherwise, so with the default `gpt-4o-mini` judge an answer like "**Augustus** was the first Roman emperor…" scored 0.5 against "Augustus" and failed a 0.8 pass mark. The rubric now judges agreement with the reference answer, not similarity: a right answer that explains itself is a pass, partial is only for a missing required part, and a wrong or contradicting answer fails. The judge now quotes the output's answer before it labels it, so a long, right answer is no longer failed for its length. The built-in scorer asks for a `pass` / `partial` / `fail` label, scored 1.0 / 0.5 / 0.0, so its results carry that label and the quoted `answer` in their metadata. The `Correctness` preset and the built-in share one rubric (`CORRECTNESS_JUDGE_CRITERIA`); it and `CORRECTNESS_JUDGE_SYSTEM_PROMPT` are identical in the Python SDK.

## [0.10.7] - 2026-10-02

### Fixed

- Use core 0.3.7, which exports spans with the worker resource so TypeScript traces appear in trace listing, drops sampling parameters for gpt-6 and Claude models that reject them, raises the Claude `max_tokens` default, and adds the `none`/`low` reasoning efforts.
- TypeScript runs now record trace spans. The worker opened no span on the dispatch path, so a run's trace came back empty even though its logs carried the trace id. Each dispatch now opens a `<type>.<name>` run span parented to the dispatch `traceparent`, with `workflow.step.<name>`, `function.<name>` and `tool.<name>` child spans and LM spans parented to the current span. The run continues the dispatch `traceparent` (or the `trace_id`/`span_id` pair on the OSS path) and keeps its sampling decision. Failures are recorded on the spans; durable sleeps, waits for user input and workerless suspensions are marked `agnt5.suspended` instead. A nested function that returns a stream keeps its span open until the stream is consumed. Log records only take trace ids from spans with real OpenTelemetry ids, so log-only spans no longer displace the dispatch `traceparent`.
- The gpt-6 family is treated as OpenAI reasoning models, like gpt-5 and the o-series: the providers send no `temperature` or `top_p` and use `max_completion_tokens`, and an Agent drops its default temperature for them. gpt-6 rejects both with a 400, so every TypeScript call to `gpt-6-luna` failed. The predicate now lives in one place, `providers/openai-models.ts`.
- An Agent on Claude Opus 4.7 and later, Sonnet 5, Opus 5 or Fable no longer sends its default temperature, and the edge Anthropic provider drops `temperature`/`top_p` for them; these models reject both with a 400. The edge provider's default `max_tokens` is 16384 for them (4096 for older Claude) since thinking counts toward it. Rules live in `providers/model-caps.ts`, mirroring sdk-core.
- An unknown `reasoningEffort` value is rejected instead of silently becoming `medium` on the native path.

### Added

- `reasoningEffort: 'none' | 'low'`. gpt-6 accepts none/low/medium/high and rejects minimal; gpt-5 accepts minimal.

## [0.10.6] - 2026-10-01

### Fixed

- Use core 0.3.5, which parses JSON and JSON-schema output into the structured object for non-streaming OpenAI responses (AGNT5-1371, AGNT5-1416).
- `ctx.logger` calls with number, boolean, array, object or null attributes no longer fail the run. Every logger now JSON-encodes non-string attribute values before handing them to the native bridge, and a record the bridge rejects is dropped with a one-time warning instead of escaping into the handler (AGNT5-1416).
- `LM.generate` with a `json` or `json_schema` `responseFormat` now returns the parsed object in `structuredOutput` when the provider leaves it unset, by parsing the response text (a single surrounding markdown code fence is unwrapped). This also applies to streamed finals and to durable replay of results recorded before this fix. Text that is not JSON leaves `structuredOutput` undefined (AGNT5-1416).

## [0.10.5] - 2026-09-25

- Add SDK-core structured assertions to Node scorer APIs and automatic native worker routing.

## [0.10.4] - 2026-09-22

### Fixed

- A panic in the native core during a durable activation now fails the call with the panic's own message, `native begin_activation panicked: <message>`, instead of napi's generic "Panic in async function", and every native panic is logged with its source location through the SDK logger. The engine connection is dropped after such a panic, so the next activation reconnects instead of reusing a channel the panic may have left broken (AGNT5-1260).

## [0.10.3] - 2026-09-22

### Fixed

- Use core 0.3.3 to preserve the certificate-assigned worker ID through pull execution and lifecycle checkpoints, reconnect pull workers and retained engine clients after certificate rotation, and keep discovery authority scoped to each connection. Fixes opt-in mTLS execution and renewal recovery; bearer authentication remains the default.

## [0.10.2] - 2026-09-22

### Added

- Opt-in external-worker mTLS with persistent authentication selection, certificate-bound tokens and restart-safe certificate renewal after a lost response.
- Independent server certificate trust through system roots or `AGNT5_WORKER_SERVER_CA_FILE`.

### Upgrade

- Existing bearer workers retain their default behavior. Enable `AGNT5_WORKER_MTLS_ENABLED=true` only after commissioning the compatible control plane and dedicated runtime mTLS endpoint, with a private persistent `AGNT5_WORKER_SESSION_DIR`. A worker already pinned to mTLS cannot silently fall back to bearer authentication.

## [0.10.1] - 2026-09-18

### Fixed

- Qualify the default judge model with its provider (`openai/gpt-4o-mini`) so the managed judge presets `correctness`, `goal_success` and `agent_judge` run without an explicit `model`. Previously every item failed with "Model must include provider prefix" (AGNT5-1225).

## [0.10.0] - 2026-09-13

### Fixed

- Build the native binding against SDK core 0.3.1 so pull workers drain accepted jobs during graceful shutdown, while idle polls stop promptly (AGNT5-1129).

### Added

- Configure response waiting for run and stream requests with `waitTimeoutMs` (zero through 24 hours); `waitTimeoutMs: 0` returns after acceptance. Response waits do not change the workflow execution deadline.

### Changed

- `Client.run()` returns HTTP 202 pending receipts directly instead of polling until completion. `RunStatus` now includes `pending`.
- Run and stream response waits default to five minutes. Chunk-only `Client.stream()` raises `RunError` with the accepted run ID when the response wait expires or detaches; `Client.events()` exposes `stream.wait_expired` and `stream.detached` events.

### Upgrade

- Configurable response waits require a gateway that supports `X-AGNT5-Wait-Timeout-Ms`.
- This minor release changes response-wait behavior. Check `RunResponse.isPending` before consuming output, retain `runId`, and use `getStatus()` / `getResult()` to read the eventual outcome when a call returns pending.
- Set `waitTimeoutMs` per call to select the gateway wait, and `timeoutMs` to retain a shorter explicit HTTP deadline. Handle stream wait events or `RunError` without resubmitting accepted work.

## [0.9.2] - 2026-09-11

### Fixed

- Ignore empty platform directories generated by NAPI while verifying public npm availability. Keep registry metadata and tarball checks before main SDK publication.


## [0.9.1] - 2026-09-11

### Fixed

- Republish all native platforms under a fresh patch version after npm left Linux x64 0.9.0 staged and publicly unavailable.
- Require public registry metadata and downloadable native tarballs before publishing the main SDK; verify the main package after publishing.
- Check native platform version alignment in PR CI.


## [0.9.0] - 2026-09-11

### Fixed

- Reject invalid `batchEval` concurrency instead of hanging without starting evaluations (AGNT5-708). Document the existing managed evaluation path.

### Changed

- Workers now default to `pull` when `AGNT5_WORKER_MODE` is unset or empty.
  Explicit `push` remains supported; set it before upgrading if your worker
  relies on coordinator-push dispatch (AGNT5-1100).

### Fixed

- Preserve durable model/tool display ancestry across concurrent agent iterations
  and streaming. The native bridge uses released SDK core 0.3.0. Deploy compatible runtime readers before these writers
  (AGNT5-1118).

## [0.8.2] - 2026-09-08

### Fixed

- Persist pull-workflow state through the runtime-backed state adapter.
- Release the activation adapter lock before RPCs to avoid serializing calls.

### Added

- Measure business execution with the shared core clock without changing
  execution results when telemetry is unavailable.

### Changed

- Build against SDK core 0.2.7 for session refresh, slot scaling, and execution
  timing observations.

## [0.8.1] - 2026-09-03

### Changed

- Build the native binding against `agnt5-sdk-core` 0.2.6.

### Fixed

- Select an edge-safe native-loader stub under `workerd` and `edge-light`
  export conditions so Cloudflare bundles can use the fetch-based LM fallback.
- Exercise the packed SDK with a real Wrangler/workerd provider call in CI.

## [0.8.0] - 2026-09-03

### Added

- Export `FunctionRegistry` from the package root and expose structured model
  output returned by the native binding.

### Changed

- Preserve assistant tool-call turns, provider continuation metadata, and
  correlated tool results across the native binding and the OpenAI Chat,
  OpenAI Responses, Anthropic, Gemini, and Bedrock edge adapters.
- Build the native binding against `agnt5-sdk-core` 0.2.5.

### Fixed

- Avoid duplicate `workflow.step.*` records when a registered function runs
  inside a durable step activation.
- Complete the router iteration before its terminal handoff record and omit an
  unresolved empty assistant transfer turn from delegated conversation history.

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

[Unreleased]: https://github.com/agnt5dev/sdk-typescript/compare/v0.8.1...HEAD
[0.8.1]: https://github.com/agnt5dev/sdk-typescript/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/agnt5dev/sdk-typescript/compare/v0.8.0-beta.6...v0.8.0
[0.8.0-beta.6]: https://github.com/agnt5dev/sdk-typescript/compare/v0.8.0-beta.5...v0.8.0-beta.6
[0.8.0-beta.5]: https://github.com/agnt5dev/sdk-typescript/compare/v0.8.0-beta.4...v0.8.0-beta.5
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
