# TypeScript SDK Implementation Plan

## Executive Summary

The AGNT5 TypeScript SDK needs to achieve feature parity with the Python SDK while maintaining idiomatic TypeScript patterns. The SDK is currently in **Phase 1** (local execution) and needs to move to **Phase 2** (platform integration).

**Current State:**
- ✅ Phase 1 complete: Local execution with in-memory state
- ✅ Function builder API, retry policies, checkpointing
- ✅ TypeScript type safety and inference
- ⚠️ Native bindings are stubs (need Rust core integration)
- ⚠️ No platform connectivity

**Target State:**
- 🎯 Full platform integration via Rust core
- 🎯 Durable state persistence
- 🎯 Multi-runtime support (Node.js, Bun, Deno, Edge)
- 🎯 Feature parity with Python SDK
- 🎯 Production-ready with comprehensive testing

---

## Architecture Overview

### Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────┐
│                TypeScript Layer (Idiomatic TS)          │
│  • Function, Workflow, Agent, Entity, Tool              │
│  • Context API, Worker, Client                          │
│  • Runtime adapters (Node, Edge, Bun, Deno)             │
└─────────────────────────────────────────────────────────┘
                            │
                            │ FFI Bridge
                            ▼
┌─────────────────────────────────────────────────────────┐
│            Native/WASM Bindings (Rust ↔ TS)             │
│  • NAPI-RS for Node.js/Bun/Deno                         │
│  • WASM for Edge runtimes (Cloudflare, Vercel)          │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│              Rust Core (sdk-core)                       │
│  • gRPC communication                                   │
│  • Protocol buffer serialization                        │
│  • Transport reliability                               │
│  • Message routing                                     │
└─────────────────────────────────────────────────────────┘
```

### Key Design Principles

1. **Clear Separation of Concerns:**
   - **Rust Core:** Transport, protocol, reliability
   - **Native Bindings:** FFI bridge, type conversion
   - **TypeScript Layer:** Business logic, runtime adaptation, developer API

2. **Runtime Adapter Pattern (TypeScript-Internal):**
   - Node.js: NAPI native bindings
   - Bun: NAPI native bindings
   - Deno: NAPI with compatibility
   - Edge (Cloudflare/Vercel): WASM bindings

3. **Progressive Disclosure:**
   - Simple API for common cases
   - Advanced options available when needed

---

## Phase 2 Implementation Roadmap

### Phase 2.1: Core Rust Bindings (Weeks 1-2)

**Objective:** Connect TypeScript to Rust core via NAPI-RS

#### Tasks:

1. **Enhance NAPI Bindings** (`sdk-typescript/native/src/lib.rs`)
   - [ ] Implement Worker `run()` method with async NAPI
   - [ ] Add message handler callback interface
   - [ ] Implement component registration
   - [ ] Add error type conversions (Rust ↔ TypeScript)
   - [ ] Implement gRPC streaming message handling

2. **Worker Integration**
   - [ ] Connect to sdk-core Worker
   - [ ] Handle registration with coordinator
   - [ ] Implement bidirectional streaming
   - [ ] Add health check and heartbeat
   - [ ] Handle graceful shutdown

3. **Context State Management**
   - [ ] Expose sdk-core state operations via NAPI
   - [ ] Implement durable checkpointing
   - [ ] Add state get/set/delete operations
   - [ ] Handle state serialization (JSON)

4. **Build System**
   - [ ] Configure cargo for NAPI cross-compilation
   - [ ] Add platform-specific build targets
   - [ ] Test on Linux, macOS, Windows
   - [ ] Generate .node binaries

**Reference Implementation:**
- Python: `sdk/sdk-python/rust-src/worker.rs`
- Rust Core: `sdk/sdk-core/src/worker.rs`

**Deliverables:**
- Working NAPI bindings that connect to platform
- Automated build script for all platforms
- Basic integration test connecting to dev-server

---

### Phase 2.2: TypeScript Integration Layer (Weeks 2-3)

**Objective:** Update TypeScript layer to use native bindings

#### Tasks:

1. **Update Worker Implementation** (`src/worker.ts`)
   - [ ] Load native module dynamically based on runtime
   - [ ] Implement message handler that calls TypeScript functions
   - [ ] Add component auto-discovery from decorators
   - [ ] Implement registration logic
   - [ ] Add error handling and reconnection

2. **Update Context Implementation** (`src/context.ts`)
   - [ ] Replace in-memory state with NAPI state operations
   - [ ] Make checkpointing durable via Rust core
   - [ ] Add distributed tracing integration
   - [ ] Implement proper logging with OpenTelemetry

3. **Runtime Detection and Loading**
   - [ ] Create runtime detector utility
   - [ ] Implement conditional module loading
   - [ ] Handle NAPI for Node/Bun/Deno
   - [ ] Add fallback for unsupported runtimes
   - [ ] Error messages for missing binaries

4. **Function Registry**
   - [ ] Create registry similar to Python's FunctionRegistry
   - [ ] Support decorator-based registration
   - [ ] Handle component metadata extraction
   - [ ] Implement JSON schema generation for input/output

**Reference Implementation:**
- Python: `sdk/sdk-python/src/agnt5/worker.py`
- Python: `sdk/sdk-python/src/agnt5/function.py`

**Deliverables:**
- Worker that can register with platform
- Functions execute with durable state
- Context provides platform-backed operations

---

### Phase 2.3: Component Implementations (Weeks 3-5)

**Objective:** Implement all component types

#### 2.3.1 Functions ✅ (Already in Phase 1)
- [x] Function builder API
- [x] Retry policies
- [x] Backoff strategies
- [ ] Platform integration
- [ ] Distributed execution

#### 2.3.2 Workflows
- [ ] Workflow builder API (`src/workflow.ts`)
- [ ] Step orchestration
- [ ] Parallel execution primitives
- [ ] Child workflow spawning
- [ ] Saga pattern support
- [ ] State machine implementation

#### 2.3.3 Agents
- [ ] Agent class implementation (`src/agent.ts`)
- [ ] LLM client integration
- [ ] Tool calling mechanism
- [ ] Agent-as-tool pattern
- [ ] Handoff pattern
- [ ] Streaming support
- [ ] Multi-agent coordination

#### 2.3.4 Tools
- [ ] Tool decorator (`src/tool.ts`)
- [ ] Schema generation from TypeScript types
- [ ] Parameter validation
- [ ] Tool registry
- [ ] Integration with Agent

#### 2.3.5 Entities
- [ ] Entity class implementation (`src/entity.ts`)
- [ ] State persistence
- [ ] Event sourcing
- [ ] Signal handling
- [ ] Query operations
- [ ] Entity lifecycle management

**Reference Implementation:**
- Python: `sdk/sdk-python/src/agnt5/workflow.py`
- Python: `sdk/sdk-python/src/agnt5/agent.py`
- Python: `sdk/sdk-python/src/agnt5/tool.py`
- Python: `sdk/sdk-python/src/agnt5/entity.py`

**Deliverables:**
- Each component type fully functional
- Examples for each component
- Integration tests

---

### Phase 2.4: WASM Bindings for Edge Runtimes (Weeks 5-6)

**Objective:** Enable deployment to edge runtimes

#### Tasks:

1. **WASM Bindings** (`sdk-typescript/wasm/src/lib.rs`)
   - [ ] Implement wasm-bindgen exports
   - [ ] Handle async operations in WASM
   - [ ] Add WebSocket-based gRPC (gRPC-Web)
   - [ ] Implement message serialization
   - [ ] Handle WASM memory constraints

2. **TypeScript WASM Integration**
   - [ ] Create WASM loader module
   - [ ] Handle WASM initialization
   - [ ] Implement runtime detection for edge
   - [ ] Add polyfills for missing APIs

3. **Edge Runtime Support**
   - [ ] Test on Cloudflare Workers
   - [ ] Test on Vercel Edge Functions
   - [ ] Test on Next.js Edge Runtime
   - [ ] Document limitations and workarounds

**Deliverables:**
- WASM bindings that work in edge runtimes
- Example deployments for each edge platform
- Documentation on edge-specific constraints

---

### Phase 2.5: LLM and AI Integration (Weeks 6-7)

**Objective:** Add AI capabilities

#### Tasks:

1. **LLM Client Bindings**
   - [ ] Expose sdk-core LLM clients via NAPI/WASM
   - [ ] Support OpenAI, Anthropic, OpenRouter, Vertex AI
   - [ ] Implement streaming responses
   - [ ] Add structured output support
   - [ ] Implement retry and fallback

2. **Agent Implementation**
   - [ ] Integrate LLM clients with Agent class
   - [ ] Implement tool calling
   - [ ] Add conversation management
   - [ ] Support system prompts and templates
   - [ ] Implement agent handoffs

3. **Vector Database Integration**
   - [ ] Expose Qdrant client from sdk-core
   - [ ] Implement embedding generation
   - [ ] Add RAG (Retrieval Augmented Generation) helpers
   - [ ] Document usage patterns

**Reference Implementation:**
- Python: `sdk/sdk-python/src/agnt5/lm.py`
- Python: `sdk/sdk-python/rust-src/language_model.rs`
- Rust Core: `sdk/sdk-core/src/llm/` (if exists)

**Deliverables:**
- Working LLM integration
- Agent with tool calling
- RAG examples
- Multi-agent examples

---

### Phase 2.6: Testing Infrastructure (Weeks 7-8)

**Objective:** Comprehensive testing

#### Tasks:

1. **Unit Tests**
   - [ ] Test all TypeScript components
   - [ ] Test NAPI bindings (mock Rust layer)
   - [ ] Test WASM bindings
   - [ ] Achieve >80% code coverage

2. **Integration Tests**
   - [ ] Create TypeScript test-bench (like Python)
   - [ ] Test against local dev-server
   - [ ] Test all component types
   - [ ] Test error scenarios and recovery
   - [ ] Test state persistence and recovery

3. **E2E Tests**
   - [ ] Multi-step workflows
   - [ ] Agent coordination
   - [ ] Entity state management
   - [ ] Cross-language interop (Python ↔ TypeScript)

4. **Performance Tests**
   - [ ] Benchmark throughput
   - [ ] Measure latency
   - [ ] Test concurrent execution
   - [ ] Memory leak detection

**Deliverables:**
- Comprehensive test suite
- Test-bench application
- Performance benchmarks
- CI/CD integration

---

### Phase 2.7: Documentation and Examples (Week 8)

**Objective:** Production-ready documentation

#### Tasks:

1. **API Documentation**
   - [ ] Generate TypeDoc from source
   - [ ] Document all public APIs
   - [ ] Add JSDoc comments
   - [ ] Create migration guide from Phase 1

2. **Examples**
   - [ ] Port all Python examples to TypeScript
   - [ ] Create runtime-specific examples
   - [ ] Add deployment examples
   - [ ] Create tutorial series

3. **Guides**
   - [ ] Getting started guide
   - [ ] Migration from other frameworks
   - [ ] Best practices
   - [ ] Troubleshooting guide
   - [ ] Multi-runtime deployment guide

**Deliverables:**
- Complete API documentation
- 15+ working examples
- Comprehensive guides

---

## Development Workflow

### Setting Up Development Environment

```bash
# 1. Install dependencies
cd sdk/sdk-typescript
npm install

# 2. Build Rust bindings
npm run build:napi

# 3. Build TypeScript
npm run build:ts

# 4. Run tests
npm test

# 5. Start development with watch mode
npm run dev
```

### Testing Strategy

Following the Python SDK pattern:

```bash
# 1. Build development version
just sdk release-develop

# 2. Start test-bench with dev-server
just platform start-dev-server typescript

# 3. Test changes
npm test

# 4. Restart test-bench after changes
pm2 restart agnt5-typescript-test-bench
```

### Build Targets

**NAPI Bindings:**
- Linux (x86_64, aarch64)
- macOS (x86_64, aarch64/Apple Silicon)
- Windows (x86_64)

**WASM Bindings:**
- Bundler target (for webpack/vite)
- Web target (for edge runtimes)

---

## Comparison: Python vs TypeScript

### Python SDK Structure
```
sdk-python/
├── src/agnt5/
│   ├── __init__.py
│   ├── worker.py          # Worker implementation
│   ├── function.py        # Function decorator and registry
│   ├── workflow.py        # Workflow implementation
│   ├── agent.py           # Agent implementation
│   ├── tool.py            # Tool decorator
│   ├── entity.py          # Entity implementation
│   ├── context.py         # Context API
│   ├── client.py          # Platform client
│   └── lm.py              # LLM integration
├── rust-src/
│   ├── lib.rs             # PyO3 exports
│   ├── worker.rs          # Worker bindings
│   ├── language_model.rs  # LLM bindings
│   └── entity_state.rs    # Entity state bindings
└── tests/
```

### TypeScript SDK Structure (Target)
```
sdk-typescript/
├── src/
│   ├── index.ts
│   ├── worker.ts          # Worker implementation
│   ├── function.ts        # Function builder
│   ├── workflow.ts        # Workflow builder
│   ├── agent.ts           # Agent implementation
│   ├── tool.ts            # Tool decorator
│   ├── entity.ts          # Entity implementation
│   ├── context.ts         # Context API
│   ├── client.ts          # Platform client
│   ├── lm.ts              # LLM integration
│   └── runtime/           # Runtime detection and loading
│       ├── detector.ts
│       ├── loader.ts
│       └── adapters.ts
├── native/                # NAPI-RS bindings
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs         # NAPI exports
│       ├── worker.rs      # Worker bindings
│       ├── context.rs     # Context bindings
│       └── lm.rs          # LLM bindings
├── wasm/                  # WASM bindings
│   ├── Cargo.toml
│   └── src/lib.rs
└── test-bench/            # Integration test application
```

---

## Key Implementation Differences

### 1. Decorators vs Builders

**Python (Decorators):**
```python
@function
async def greet(ctx: Context, name: str) -> str:
    return f"Hello, {name}!"
```

**TypeScript (Builders - Current):**
```typescript
export const greet = fn('greet').run(async (ctx, name: string) => {
  return `Hello, ${name}!`;
});
```

**TypeScript (Decorators - Future with Stage 3):**
```typescript
@fn('greet')
async function greet(ctx: Context, name: string): Promise<string> {
  return `Hello, ${name}!`;
}
```

### 2. Type Safety

TypeScript offers stronger compile-time guarantees:

```typescript
// TypeScript infers return type and validates at compile time
const result = await greet(ctx, "World"); // result: string

// Python requires runtime validation
result = await greet(ctx, "World")  # type: str (not enforced)
```

### 3. Async/Await

Both languages use async/await, but TypeScript Promises vs Python asyncio:

```typescript
// TypeScript - native Promises
async function workflow(ctx: Context) {
  const a = await step1(ctx);
  const b = await step2(ctx, a);
  return b;
}
```

```python
# Python - asyncio
async def workflow(ctx: Context):
    a = await step1(ctx)
    b = await step2(ctx, a)
    return b
```

### 4. Runtime Adaptation

**Python:** Single runtime (CPython)
**TypeScript:** Multiple runtimes require conditional loading

```typescript
// runtime/loader.ts
export function loadNativeBinding() {
  if (isNode() || isBun() || isDeno()) {
    return require('../native/agnt5-sdk-native.node');
  } else if (isEdgeRuntime()) {
    return import('../wasm/agnt5_sdk_wasm.js');
  } else {
    throw new Error('Unsupported runtime');
  }
}
```

---

## Risk Assessment and Mitigation

### Technical Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| NAPI async complexity | High | Medium | Start with Python bindings as reference, use napi-rs async primitives |
| WASM limitations (no threads) | Medium | High | Document limitations, use WebWorkers where available |
| Runtime detection edge cases | Medium | Medium | Comprehensive testing across all runtimes |
| TypeScript decorator instability | Low | Low | Use builders primarily, add decorator support later |
| Memory leaks in FFI boundary | High | Low | Rigorous testing, proper cleanup in bindings |

### Process Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Scope creep | Medium | Medium | Follow phased approach strictly |
| Feature parity delays | High | Medium | Prioritize core features first, advanced features later |
| Testing coverage gaps | High | Low | Create test-bench early in Phase 2.1 |

---

## Success Criteria

### Phase 2 Complete When:

1. ✅ **Platform Connectivity:**
   - Worker connects to coordinator
   - Bidirectional streaming works
   - Reconnection and health checks functional

2. ✅ **Durable Execution:**
   - State persists across restarts
   - Checkpoints are durable
   - Exactly-once guarantees work

3. ✅ **Component Parity:**
   - Function, Workflow, Agent, Tool, Entity all implemented
   - Feature parity with Python SDK
   - Idiomatic TypeScript APIs

4. ✅ **Multi-Runtime Support:**
   - Works on Node.js, Bun, Deno (NAPI)
   - Works on Cloudflare Workers, Vercel Edge (WASM)
   - Automatic runtime detection

5. ✅ **Production Quality:**
   - >80% test coverage
   - Comprehensive documentation
   - Published to npm
   - Deployment examples

6. ✅ **Developer Experience:**
   - Simple getting started (< 5 minutes)
   - TypeScript type safety throughout
   - Great error messages
   - Debugging tools

---

## Timeline Summary

| Phase | Duration | Key Deliverable |
|-------|----------|-----------------|
| 2.1 Core Rust Bindings | 2 weeks | NAPI bindings connect to platform |
| 2.2 TypeScript Integration | 1 week | Worker registers and executes functions |
| 2.3 Component Implementations | 2 weeks | All component types working |
| 2.4 WASM Bindings | 1 week | Edge runtime support |
| 2.5 LLM Integration | 1 week | Agent with LLM capabilities |
| 2.6 Testing Infrastructure | 1 week | Comprehensive test suite |
| 2.7 Documentation | 1 week | Production-ready docs |
| **Total** | **8 weeks** | **Production-ready TypeScript SDK** |

---

## Getting Started with Development

### Immediate Next Steps (Week 1)

1. **Set up NAPI development environment**
   ```bash
   # Install Rust
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

   # Install napi-rs CLI (already in package.json)
   cd sdk/sdk-typescript
   npm install
   ```

2. **Study Python bindings as reference**
   - Read: `sdk/sdk-python/rust-src/worker.rs`
   - Understand: Message handler callback pattern
   - Understand: State management integration

3. **Implement first NAPI method**
   - Start with Worker `run()` method
   - Connect to sdk-core Worker
   - Test basic connectivity

4. **Create minimal test-bench**
   - Create: `sdk/sdk-typescript/test-bench/`
   - Implement: Simple function worker
   - Test: Registration with dev-server

### Development Tips

1. **Use Python SDK as North Star:** When in doubt, check how Python SDK does it
2. **Test Early and Often:** Don't wait until Phase 2.6 to test
3. **Follow TypeScript Idioms:** Make it feel natural for TS developers
4. **Document as You Go:** Don't leave docs for the end
5. **Keep It Simple:** Match Python's simplicity, leverage TS types

---

## Appendix: Key Files Reference

### Python SDK (Reference Implementation)
- Worker: `sdk/sdk-python/src/agnt5/worker.py`
- Function: `sdk/sdk-python/src/agnt5/function.py`
- Context: `sdk/sdk-python/src/agnt5/context.py`
- Agent: `sdk/sdk-python/src/agnt5/agent.py`
- Bindings: `sdk/sdk-python/rust-src/worker.rs`
- Test Bench: `sdk/sdk-python/tests/integration/test-bench/app.py`

### Rust Core
- Worker: `sdk/sdk-core/src/worker.rs`
- Client: `sdk/sdk-core/src/client.rs`
- Config: `sdk/sdk-core/Cargo.toml`

### TypeScript SDK (To Implement)
- Worker: `sdk/sdk-typescript/src/worker.ts`
- NAPI: `sdk/sdk-typescript/native/src/lib.rs`
- WASM: `sdk/sdk-typescript/wasm/src/lib.rs`
- Build: `sdk/sdk-typescript/package.json`

---

## Questions to Resolve

1. **Decorator Support:** Wait for Stage 3 decorators or provide babel plugin?
2. **Package Name:** Publish as `@agnt5/sdk` or `agnt5`?
3. **Node Version:** Support Node 16+ or require Node 18+?
4. **WASM Size:** Optimize for size or include all features?
5. **Type Generation:** Generate types from protos or maintain manually?

---

## Conclusion

The TypeScript SDK implementation is well-planned and follows the proven architecture of the Python SDK. The phased approach reduces risk and ensures continuous progress. With the Rust core already mature and Python SDK as a reference, TypeScript SDK can achieve production quality within 8 weeks.

**Key Success Factors:**
- Leverage existing Rust core
- Follow Python SDK patterns
- Maintain TypeScript idioms
- Test continuously
- Document thoroughly

**Ready to Start:** Phase 2.1 can begin immediately with NAPI bindings development.
