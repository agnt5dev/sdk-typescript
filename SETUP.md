# TypeScript SDK Setup Guide

## Quick Start

The TypeScript SDK is now set up with the complete infrastructure. Here's how to get started:

### 1. Install Dependencies

```bash
cd sdk/sdk-typescript
npm install
```

### 2. Build TypeScript

```bash
npm run build:ts
```

### 3. Run Tests

```bash
npm test
```

### 4. Try the Examples

```bash
# Build first
npm run build:ts

# Run basic function example
node dist/examples/basic-function.js

# Run checkpointing example
node dist/examples/checkpointing.js
```

## What's Been Set Up

### ✅ Complete Project Structure

```
sdk-typescript/
├── package.json           # NPM package with conditional exports
├── tsconfig.json          # TypeScript configuration
├── vitest.config.ts       # Test configuration
├── src/                   # Source code
│   ├── index.ts          # Main exports
│   ├── types.ts          # TypeScript types
│   ├── function.ts       # Function builder
│   ├── context.ts        # Execution context
│   ├── worker.ts         # Worker implementation
│   └── __tests__/        # Test files
├── native/               # NAPI-RS bindings
│   ├── Cargo.toml       # Rust package config
│   ├── build.rs         # Build script
│   └── src/lib.rs       # NAPI bindings
├── wasm/                 # WASM bindings
│   ├── Cargo.toml       # Rust package config
│   └── src/lib.rs       # WASM bindings
├── examples/             # Working examples
├── docs/                 # Complete documentation
└── scripts/              # Build scripts
```

### ✅ Phase 1 Implementation (Local Execution)

**Working Features:**
- ✅ Function builder API with fluent interface
- ✅ Retry policies (maxAttempts, intervals)
- ✅ Backoff strategies (constant, linear, exponential)
- ✅ Context implementation with state management
- ✅ Checkpointing for idempotent operations
- ✅ Structured logging
- ✅ Worker infrastructure
- ✅ Test suite with vitest
- ✅ Working examples

**Current Limitations:**
- ⚠️ State is in-memory (not durable)
- ⚠️ Checkpoints are in-memory (not durable)
- ⚠️ No platform integration yet
- ⚠️ NAPI/WASM bindings are stubs (need Rust core integration)

### ✅ Documentation

Complete documentation in `docs/`:
- `overview.md` - Architecture and component hierarchy
- `function.md` - Function API guide
- `context.md` - Context capabilities
- `tool.md` - Tool definitions (Phase 2)
- `agent.md` - Agent patterns (Phase 2)
- `entity.md` - Entity component (Phase 2)
- `workflow.md` - Workflow orchestration (Phase 2)
- `runtime-support.md` - Multi-runtime strategy

### ✅ Testing Infrastructure

- Vitest for fast unit testing
- Code coverage with V8
- Test files for all components
- Example-based testing

## Development Workflow

### Watch Mode

```bash
npm run dev
```

This starts TypeScript in watch mode - changes are automatically compiled.

### Run Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test -- --watch

# Run with coverage
npm run test -- --coverage
```

### Build Everything

```bash
npm run build
```

Currently builds TypeScript only. NAPI and WASM builds will be added in Phase 2.

## Next Steps

### Phase 2: Platform Integration

To complete Phase 2, you'll need to:

1. **Integrate with sdk-core**
   - Update NAPI bindings to call sdk-core
   - Update WASM bindings to call sdk-core
   - Add feature flags for different targets

2. **Add Build System**
   - Install Rust toolchain: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
   - Install wasm-pack: `cargo install wasm-pack`
   - Install @napi-rs/cli: Already in package.json

3. **Build Bindings**
   ```bash
   # Build NAPI for Node.js/Bun/Deno
   npm run build:napi

   # Build WASM for edge runtimes
   npm run build:wasm
   ```

4. **Update TypeScript to Use Bindings**
   - Modify `src/worker.ts` to load native/wasm modules
   - Implement conditional loading based on runtime
   - Add proper error handling

5. **Platform Features**
   - Connect to AGNT5 Gateway
   - Implement durable state with CockroachDB projections
   - Add orchestration APIs (task, parallel, gather, spawn)
   - Integrate LLM clients
   - Add Tool, Agent, Entity, Workflow components

## Testing the Current Implementation

### Basic Function Test

```typescript
import { fn, ContextImpl } from '@agnt5/sdk';

const greet = fn('greet').run(async (ctx, name: string) => {
  return `Hello, ${name}!`;
});

const ctx = new ContextImpl('inv-1', 'run-1', 0, 'test');
const result = await greet(ctx, 'World');
console.log(result); // "Hello, World!"
```

### Checkpointing Test

```typescript
const pipeline = fn('pipeline').run(async (ctx, data: string) => {
  const step1 = await ctx.step('load', () => loadData(data));
  const step2 = await ctx.step('transform', () => transform(step1));
  return step2;
});

// Steps are checkpointed - won't re-execute on retry
```

### Retry Policy Test

```typescript
const retryable = fn('retryable')
  .retry({ maxAttempts: 3, initialIntervalMs: 1000 })
  .backoff({ type: 'exponential', multiplier: 2.0 })
  .run(async (ctx, data: string) => {
    // Will retry up to 3 times with exponential backoff
    return process(data);
  });
```

## Troubleshooting

### TypeScript Errors

```bash
# Clean and rebuild
rm -rf dist/
npm run build:ts
```

### Test Failures

```bash
# Clear cache and rerun
npm run test -- --clearCache
```

### Missing Dependencies

```bash
# Reinstall all dependencies
rm -rf node_modules/
npm install
```

## Resources

- [TypeScript Documentation](https://www.typescriptlang.org/docs/)
- [Vitest Documentation](https://vitest.dev/)
- [NAPI-RS Documentation](https://napi.rs/)
- [wasm-bindgen Guide](https://rustwasm.github.io/docs/wasm-bindgen/)

## Status

✅ **Phase 1 Complete** - Local execution infrastructure ready
📋 **Phase 2 Pending** - Platform integration (Rust bindings, durable state, distributed execution)

The SDK is now ready for development and testing in local mode!
