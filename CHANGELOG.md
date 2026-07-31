# Changelog

All notable changes to the AGNT5 TypeScript SDK are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/agnt5dev/sdk-typescript/compare/v0.6.6...HEAD
[0.6.6]: https://github.com/agnt5dev/sdk-typescript/compare/v0.6.5...v0.6.6
[0.6.5]: https://github.com/agnt5dev/sdk-typescript/compare/v0.6.4...v0.6.5
[0.6.4]: https://github.com/agnt5dev/sdk-typescript/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/agnt5dev/sdk-typescript/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/agnt5dev/sdk-typescript/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/agnt5dev/sdk-typescript/releases/tag/v0.6.1
