import type { WorkerOptions, Context } from './types.js';
import { FunctionRegistry } from './function.js';
import { WorkflowRegistry } from './workflow.js';
import { ToolRegistry } from './tool.js';
import { Agent } from './agent.js';
import type { AgentResult } from './agent.js';
import { ChatBot } from './chat.js';
import { runWithContext } from './async-context.js';
import { WaitingForUserInputError } from './errors.js';
import type { HITLInputType, HITLOption } from './errors.js';
import { EventEmitter } from './event-emitter.js';
import {
  generateCid,
  runStarted, runCompleted, runFailed,
  functionStarted, functionCompleted, functionFailed,
  workflowStarted, workflowCompleted, workflowFailed,
  toolStarted, toolCompleted, toolFailed,
} from './events.js';
import type { AgentEvent } from './events.js';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Dynamic import for native bindings
let nativeBindings: any = null;

/**
 * Load native bindings based on platform
 */
function loadNativeBindings() {
  if (nativeBindings) return nativeBindings;

  try {
    const runtime = getRuntime();

    if (runtime === 'edge') {
      // TODO: Load WASM bindings for edge runtimes
      throw new Error('WASM bindings not yet implemented');
    }

    // Load NAPI bindings for Node.js/Bun/Deno
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const require = createRequire(import.meta.url);

    // Try multiple paths to find the native module
    const possiblePaths = [
      join(__dirname, '../../native/agnt5-sdk-native.darwin-arm64.node'),      // From dist/src (macOS)
      join(__dirname, '../native/agnt5-sdk-native.darwin-arm64.node'),         // From src (macOS)
      join(__dirname, '../../native/agnt5-sdk-native.linux-x64-gnu.node'),     // From dist/src (Linux)
      join(__dirname, '../native/agnt5-sdk-native.linux-x64-gnu.node'),        // From src (Linux)
      join(__dirname, '../../native/agnt5-sdk-native.linux-x64.node'),         // From dist/src (Linux fallback)
      join(__dirname, '../native/agnt5-sdk-native.linux-x64.node'),            // From src (Linux fallback)
    ];

    for (const nativePath of possiblePaths) {
      try {
        nativeBindings = require(nativePath);
        return nativeBindings;
      } catch (e) {
        // Try next path
        continue;
      }
    }

    throw new Error('Could not find native bindings in any expected location');
  } catch (error) {
    throw new Error(`Failed to load native bindings: ${(error as Error).message}`);
  }
}

/**
 * Platform worker configuration
 */
export interface PlatformWorkerOptions extends WorkerOptions {
  /** Service name */
  serviceName: string;
  /** Service version */
  serviceVersion?: string;
  /** Service type */
  serviceType?: string;
  /** Platform coordinator endpoint */
  coordinatorEndpoint?: string;
  /** Tenant ID */
  tenantId?: string;
  /** Deployment ID */
  deploymentId?: string;
  /** Auto-discover components from registries (default: false) */
  autoRegister?: boolean;
  /**
   * Enable pull-based job queue polling (default: false).
   * When enabled, the worker polls the platform for pending jobs
   * in addition to receiving push-based dispatch via streaming.
   * Requires NAPI bindings with PollJobs/CompleteJob support.
   */
  enableJobQueue?: boolean;
  /** Maximum concurrent jobs from queue (default: 5) */
  jobQueueConcurrency?: number;
  /** Initial poll interval in milliseconds (default: 1000) */
  jobQueuePollIntervalMs?: number;
  /** Maximum poll interval with exponential backoff (default: 30000) */
  jobQueueMaxPollIntervalMs?: number;
}

/**
 * Simple context implementation
 */
class SimpleContext implements Context {
  private _emitter?: EventEmitter;
  private _nativeWorker?: any;
  private _stepCounter = 0;
  private _stepCache = new Map<string, any>();

  // HITL state — populated by Worker.processMessage on resume from message metadata.
  // _pauseIndex is the running counter incremented by each waitForUser call.
  // _userResponses is a sparse cache of {pauseIndex -> user response} populated
  // from the resume metadata so the workflow handler can replay past pauses.
  // FIXME(hitl-replay): only the LATEST pause's response is currently restored.
  // Multi-step HITL replay (where the workflow re-runs through several past
  // pauses) needs full step-event accumulation + persistence in pause metadata,
  // matching what sdk-python's WorkflowEntity does. See
  // sdk-python/src/agnt5/workflow.py:1611 for the persistence side and
  // sdk-python/src/agnt5/worker/_executors.py:1311 for the restore side.
  private _pauseIndex = 0;
  private _userResponses = new Map<number, string | null>();

  constructor(
    public readonly invocationId: string,
    public readonly runId: string,
    public readonly attempt: number,
    public readonly serviceName: string,
    private state: Map<string, any> = new Map()
  ) {}

  /**
   * Seed HITL replay state from incoming message metadata.
   * Called by Worker.processMessage before invoking the workflow handler.
   *
   * Reads `user_response` and `pause_index` from metadata (set by the gateway's
   * resume endpoint at runtime/crates/gateway/src/handlers/signals.rs) and
   * caches the response so the next waitForUser call at that index returns it
   * instead of throwing.
   */
  loadReplayState(metadata: Record<string, string> | undefined): void {
    if (!metadata) return;

    const userResponse = metadata.user_response;
    if (userResponse === undefined) return;

    const pauseIndexStr = metadata.pause_index ?? '0';
    const pauseIndex = Number.parseInt(pauseIndexStr, 10);
    if (Number.isNaN(pauseIndex)) return;

    // Wire-format decoding mirrors sdk-python's wait_for_user (workflow.py:1520):
    // "__skipped__" → null, "__custom__:..." → strip prefix.
    let decoded: string | null = userResponse;
    if (userResponse === '__skipped__' || userResponse === '__skip__') {
      decoded = null;
    } else if (userResponse.startsWith('__custom__:')) {
      decoded = userResponse.slice('__custom__:'.length);
    }

    this._userResponses.set(pauseIndex, decoded);
  }

  setEmitter(emitter: EventEmitter): void {
    this._emitter = emitter;
  }

  setNativeWorker(worker: any): void {
    this._nativeWorker = worker;
  }

  async emit(event: any): Promise<void> {
    if (this._emitter) {
      await this._emitter.emit(event);
    }
  }

  get logger() {
    const runId = this.runId;
    return {
      info: (message: string, meta?: Record<string, any>) => {
        console.log(`[INFO] ${message}`, meta || {});
        nativeBindings?.logFromTypescript('INFO', message, runId, null, null, meta ?? null);
      },
      error: (message: string, meta?: Record<string, any>) => {
        console.error(`[ERROR] ${message}`, meta || {});
        nativeBindings?.logFromTypescript('ERROR', message, runId, null, null, meta ?? null);
      },
      warn: (message: string, meta?: Record<string, any>) => {
        console.warn(`[WARN] ${message}`, meta || {});
        nativeBindings?.logFromTypescript('WARN', message, runId, null, null, meta ?? null);
      },
      debug: (message: string, meta?: Record<string, any>) => {
        console.debug(`[DEBUG] ${message}`, meta || {});
        nativeBindings?.logFromTypescript('DEBUG', message, runId, null, null, meta ?? null);
      },
    };
  }

  async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
    return this.state.has(key) ? this.state.get(key) : defaultValue;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.state.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.state.delete(key);
  }

  /**
   * Pause the workflow and request user input (HITL).
   *
   * On first call: throws WaitingForUserInputError, which Worker.processMessage
   * catches and propagates as a `waiting_for_user_input` response to the
   * platform. On resume, the platform re-dispatches the workflow with the
   * user's response in metadata; loadReplayState seeds _userResponses, and
   * the next call at the matching pauseIndex returns the cached value.
   *
   * Mirrors sdk-python/src/agnt5/workflow.py wait_for_user. The TS resume
   * cache currently only restores the LATEST pause — see the FIXME at
   * _userResponses for the multi-step replay limitation.
   */
  async waitForUser(
    question: string,
    options?: {
      inputType?: HITLInputType;
      options?: HITLOption[];
      allowCustom?: boolean;
      skippable?: boolean;
    },
  ): Promise<string | null> {
    const pauseIndex = this._pauseIndex++;

    // Resume path: response was injected from metadata before handler ran.
    if (this._userResponses.has(pauseIndex)) {
      return this._userResponses.get(pauseIndex)!;
    }

    // First-time path: throw to pause execution. The worker catches and
    // sends back a `waiting_for_user_input` response, which the runtime
    // turns into a workflow.paused event.
    throw new WaitingForUserInputError({
      runId: this.runId,
      question,
      inputType: options?.inputType,
      options: options?.options,
      pauseIndex,
      allowCustom: options?.allowCustom,
      skippable: options?.skippable,
      stepName: `wait_for_user_${pauseIndex}`,
    });
  }

  /**
   * Execute a durable step with checkpointing.
   *
   * On first execution: runs fn(), caches result, emits checkpoint.
   * On replay: returns cached result without re-executing.
   */
  async step<T>(stepName: string, fn: () => T | Promise<T>): Promise<T> {
    const stepKey = `step:${stepName}:${this._stepCounter++}`;

    // Check local cache first (same-run replay)
    if (this._stepCache.has(stepKey)) {
      return this._stepCache.get(stepKey);
    }

    // Emit step.started checkpoint via NAPI if available
    const seqNum = this._stepCounter;
    const tsNs = Date.now() * 1_000_000;
    if (this._nativeWorker?.emitCheckpoint) {
      try {
        await this._nativeWorker.emitCheckpoint(
          this.runId,
          'workflow.step.started',
          JSON.stringify({ step_key: stepKey, step_name: stepName }),
          seqNum,
          {},
          tsNs,
        );
      } catch { /* checkpoint emission is best-effort */ }
    }

    // Execute the step
    const startMs = Date.now();
    const result = await fn();
    const durationMs = Date.now() - startMs;

    // Cache locally
    this._stepCache.set(stepKey, result);

    // Emit step.completed checkpoint
    if (this._nativeWorker?.emitCheckpoint) {
      try {
        await this._nativeWorker.emitCheckpoint(
          this.runId,
          'workflow.step.completed',
          JSON.stringify({
            step_key: stepKey,
            step_name: stepName,
            output: result,
            duration_ms: durationMs,
          }),
          seqNum + 1,
          {},
          Date.now() * 1_000_000,
        );
      } catch { /* checkpoint emission is best-effort */ }
    }

    return result;
  }
}

/**
 * Worker class for running AGNT5 functions with platform integration
 */
export class Worker {
  private serviceName: string;
  private options: PlatformWorkerOptions;
  private nativeWorker: any;
  private isInitialized = false;

  constructor(serviceName: string, options: Partial<PlatformWorkerOptions> = {}) {
    this.serviceName = serviceName;
    this.options = {
      ...options,
      serviceName,
      runtime: 'standalone',
    } as PlatformWorkerOptions;
  }

  /**
   * Initialize the worker and load native bindings
   */
  private async initialize(): Promise<void> {
    if (this.isInitialized) return;

    const native = loadNativeBindings();

    // Initialize SDK
    try {
      native.initialize(this.serviceName, this.options.serviceVersion || '0.1.0');
      console.log('✓ SDK initialized with telemetry');
    } catch (error) {
      // Telemetry might already be initialized, that's okay
      console.log('SDK initialization:', (error as Error).message);
    }

    // Create native worker
    this.nativeWorker = new native.Worker({
      serviceName: this.serviceName,
      serviceVersion: this.options.serviceVersion,
      serviceType: this.options.serviceType || 'function',
      coordinatorEndpoint: this.options.coordinatorEndpoint ||
        process.env.AGNT5_COORDINATOR_ENDPOINT ||
        'http://localhost:34186',
      tenantId: this.options.tenantId ||
        process.env.AGNT5_TENANT_ID,
      deploymentId: this.options.deploymentId ||
        process.env.AGNT5_DEPLOYMENT_ID,
    });

    this.isInitialized = true;
  }

  /**
   * Get worker ID
   */
  get workerId(): string {
    if (!this.nativeWorker) {
      throw new Error('Worker not initialized. Call run() first.');
    }
    return this.nativeWorker.workerId;
  }

  /**
   * Get coordinator endpoint
   */
  get coordinatorEndpoint(): string {
    if (!this.nativeWorker) {
      throw new Error('Worker not initialized. Call run() first.');
    }
    return this.nativeWorker.coordinatorEndpoint;
  }

  /**
   * Get tenant ID
   */
  get tenantId(): string {
    if (!this.nativeWorker) {
      throw new Error('Worker not initialized. Call run() first.');
    }
    return this.nativeWorker.tenantId;
  }

  /**
   * Get deployment ID
   */
  get deploymentId(): string {
    if (!this.nativeWorker) {
      throw new Error('Worker not initialized. Call run() first.');
    }
    return this.nativeWorker.deploymentId;
  }

  /** Registered agents (keyed by name) for dispatch */
  private agents: Map<string, Agent> = new Map();

  /** Registered ChatBots (keyed by agent name) for webhook dispatch */
  private chatbots: Map<string, ChatBot> = new Map();

  /**
   * Register agents that can be dispatched by the worker.
   * Accepts both Agent and ChatBot instances. ChatBot instances
   * will have their wrapped agent registered for normal dispatch,
   * plus the ChatBot tracked for webhook routing.
   */
  registerAgents(agents: (Agent | ChatBot)[]): void {
    for (const item of agents) {
      if (item instanceof ChatBot) {
        this.chatbots.set(item.name, item);
        // ChatBot wraps an agent — register the agent for the platform
        // (The ChatBot.agent getter would need to be public for this)
        // For now, just track by name — webhook dispatch uses ChatBot directly
        console.log(`Registered ChatBot for agent '${item.name}'`);
      } else {
        this.agents.set(item.name, item);
      }
    }
  }

  /**
   * Handle incoming execution requests from the platform.
   * This is a SYNC callback (returns void) — napi-rs ThreadsafeFunction cannot
   * properly handle async (Promise) return values. Instead, async processing
   * starts here and calls nativeWorker.resolveResponse() when done, which sends
   * the result back through a Rust oneshot channel.
   */
  private handleMessage(message: {
    invocationId: string;
    componentName: string;
    componentType: string;
    inputJson: string;
    metadata: Record<string, string>;
  }): void {
    this.processMessage(message).then(
      (responseJson) => {
        this.nativeWorker.resolveResponse(message.invocationId, responseJson);
      },
      (error) => {
        this.nativeWorker.resolveResponse(
          message.invocationId,
          JSON.stringify({
            invocationId: message.invocationId,
            error: (error as Error).message || 'Unknown error',
          }),
        );
      },
    );
  }

  /**
   * Async message processing — dispatches to the appropriate component handler.
   * Wraps each dispatch with lifecycle events matching the Python SDK executor pattern:
   *   run.started → component.started → handler → component.completed/failed → run.completed/failed
   */
  private async processMessage(message: {
    invocationId: string;
    componentName: string;
    componentType: string;
    inputJson: string;
    metadata: Record<string, string>;
  }): Promise<string> {
    const runId = message.metadata?.run_id || message.invocationId;

    return runWithContext(
      {
        runId,
        sessionId: message.metadata?.session_id,
        userId: message.metadata?.user_id,
        correlationId: message.metadata?.correlation_id || message.invocationId,
        tenantId: message.metadata?.tenant_id,
      },
      async () => {
        // Create EventEmitter wired to NAPI worker for event emission
        const emitter = new EventEmitter(runId, {
          traceparent: message.metadata?.traceparent || '',
          tracestate: message.metadata?.tracestate || '',
        });
        emitter.setWorker(this.nativeWorker);

        // Correlation IDs: run CID from run_id[:8], component CID random
        const runCid = runId.slice(0, 8);
        const parentCid = message.metadata?.parent_correlation_id || null;
        const attempt = parseInt(message.metadata?.attempt || '0', 10);
        const maxAttempts = parseInt(message.metadata?.max_attempts || '1', 10);

        try {
          console.log(`📨 Received ${message.componentType} execution: ${message.componentName}`);

          // Parse input data
          const inputData = JSON.parse(message.inputJson);

          // Create context with emitter
          const ctx = new SimpleContext(
            message.invocationId,
            runId,
            attempt,
            this.serviceName,
          );
          ctx.setEmitter(emitter);
          if (this.nativeWorker) {
            ctx.setNativeWorker(this.nativeWorker);
          }
          // Seed HITL replay state from incoming resume metadata (no-op on
          // fresh dispatches). Mirrors sdk-python's executors which read
          // user_response/pause_index from request.metadata on resume.
          ctx.loadReplayState(message.metadata);

          // ── run.started ──
          await emitter.emit(runStarted(runCid, parentCid, {
            inputData,
            attempt,
          }));

          let result: any;
          const startTimeNs = BigInt(Date.now()) * 1_000_000n;

          switch (message.componentType) {
            case 'function': {
              const fn = FunctionRegistry.get(message.componentName);
              if (!fn) {
                throw new Error(`Function not found: ${message.componentName}`);
              }

              const fnCid = generateCid();

              // ── function.started ──
              await emitter.emit(functionStarted(fnCid, runCid, {
                inputData,
                attempt,
              }));

              try {
                result = await fn.handler(ctx, inputData);
                const durationMs = Number((BigInt(Date.now()) * 1_000_000n - startTimeNs) / 1_000_000n);

                // ── function.completed ──
                await emitter.emit(functionCompleted(fnCid, runCid, {
                  outputData: result,
                  durationMs,
                }));
              } catch (fnError) {
                const durationMs = Number((BigInt(Date.now()) * 1_000_000n - startTimeNs) / 1_000_000n);

                // ── function.failed ──
                await emitter.emit(functionFailed(fnCid, runCid, {
                  errorCode: 'FUNCTION_ERROR',
                  errorMessage: (fnError as Error).message,
                  durationMs,
                }));
                throw fnError;
              }
              break;
            }

            case 'workflow': {
              const wf = WorkflowRegistry.get(message.componentName);
              if (!wf) {
                throw new Error(`Workflow not found: ${message.componentName}`);
              }

              const wfCid = generateCid();

              // ── workflow.started ──
              await emitter.emit(workflowStarted(wfCid, runCid, {
                inputData,
                attempt,
              }));

              try {
                result = await wf.handler(ctx, inputData);
                const durationMs = Number((BigInt(Date.now()) * 1_000_000n - startTimeNs) / 1_000_000n);

                // ── workflow.completed ──
                await emitter.emit(workflowCompleted(wfCid, runCid, {
                  outputData: result,
                  durationMs,
                }));
              } catch (wfError) {
                const durationMs = Number((BigInt(Date.now()) * 1_000_000n - startTimeNs) / 1_000_000n);

                // ── workflow.failed ──
                await emitter.emit(workflowFailed(wfCid, runCid, {
                  errorCode: 'WORKFLOW_ERROR',
                  errorMessage: (wfError as Error).message,
                  durationMs,
                }));
                throw wfError;
              }
              break;
            }

            case 'agent': {
              // Check if this is a chat webhook dispatch
              if (inputData._chat_webhook && this.chatbots.has(message.componentName)) {
                const chatbot = this.chatbots.get(message.componentName)!;
                const platform = inputData.platform as string;
                const headers = (inputData.headers || {}) as Record<string, string>;
                const body = Buffer.from(inputData.body || '', 'utf-8');

                console.log(`💬 Chat webhook received: platform=${platform}, bot=${message.componentName}`);

                const challengeResult = await chatbot.handleWebhook(platform, headers, body);
                result = challengeResult ?? {};
                break;
              }

              const agent = this.agents.get(message.componentName);
              if (!agent) {
                throw new Error(`Agent not found: ${message.componentName}`);
              }

              // Consume the agent stream so internal events (agent.started,
              // iteration.started, tool_call.started, etc.) are forwarded to the platform.
              const userMessage = inputData.prompt || inputData.message || JSON.stringify(inputData);
              let agentResult: AgentResult | undefined;

              for await (const event of agent.stream(userMessage, ctx)) {
                if ('output' in event && 'toolCalls' in event && 'context' in event) {
                  agentResult = event as AgentResult;
                } else {
                  // Forward AgentEvent to platform via emitter
                  await emitter.emit(event as AgentEvent);
                }
              }

              if (!agentResult) {
                throw new Error(`Agent '${message.componentName}' completed without producing a result`);
              }
              result = agentResult.output;
              break;
            }

            case 'tool': {
              const tool = ToolRegistry.get(message.componentName);
              if (!tool) {
                throw new Error(`Tool not found: ${message.componentName}`);
              }

              const toolCid = generateCid();

              // ── tool.started ──
              await emitter.emit(toolStarted(toolCid, runCid, {
                inputData,
                attempt,
              }));

              try {
                result = await tool.invoke(ctx, inputData);
                const durationMs = Number((BigInt(Date.now()) * 1_000_000n - startTimeNs) / 1_000_000n);

                // ── tool.completed ──
                await emitter.emit(toolCompleted(toolCid, runCid, {
                  outputData: result,
                  durationMs,
                }));
              } catch (toolError) {
                const durationMs = Number((BigInt(Date.now()) * 1_000_000n - startTimeNs) / 1_000_000n);

                // ── tool.failed ──
                await emitter.emit(toolFailed(toolCid, runCid, {
                  errorCode: 'TOOL_ERROR',
                  errorMessage: (toolError as Error).message,
                  durationMs,
                }));
                throw toolError;
              }
              break;
            }

            default:
              throw new Error(`Unknown component type: ${message.componentType}`);
          }

          // ── run.completed ──
          await emitter.emit(runCompleted(runCid, parentCid, {
            outputData: result,
          }));

          return JSON.stringify({
            invocationId: message.invocationId,
            outputJson: JSON.stringify(result),
          });
        } catch (error) {
          // HITL: propagate pause signal to platform (no run.failed for pause)
          if (error instanceof WaitingForUserInputError) {
            return JSON.stringify({
              invocationId: message.invocationId,
              error: JSON.stringify({
                type: 'waiting_for_user_input',
                question: error.question,
                inputType: error.inputType,
                options: error.options,
                pauseIndex: error.pauseIndex,
                allowCustom: error.allowCustom,
                skippable: error.skippable,
                stepName: error.stepName,
              }),
            });
          }

          // ── run.failed ──
          try {
            await emitter.emit(runFailed(runCid, parentCid, {
              errorCode: 'EXECUTION_ERROR',
              errorMessage: (error as Error).message,
              attempt,
              maxAttempts,
            }));
          } catch (emitError) {
            console.error('Failed to emit run.failed event:', emitError);
          }

          console.error(`❌ Execution failed:`, error);
          return JSON.stringify({
            invocationId: message.invocationId,
            error: (error as Error).message,
          });
        }
      },
    );
  }

  /**
   * Start the worker and connect to platform
   */
  async run(): Promise<void> {
    await this.initialize();

    console.log(`
🚀 AGNT5 Worker Starting
   Service: ${this.serviceName}
   Worker ID: ${this.workerId}
   Coordinator: ${this.coordinatorEndpoint}
   Tenant: ${this.tenantId}
   Deployment: ${this.deploymentId}
   Runtime: ${getRuntime()}
`);

    // Collect all registered components
    const components: Array<{ name: string; componentType: string; config: Record<string, string>; metadata: Record<string, string> }> = [];

    // Functions
    for (const [name, fnConfig] of FunctionRegistry.getAll()) {
      const config: Record<string, string> = {};

      if (fnConfig.options.retries?.maxAttempts !== undefined) {
        config.max_attempts = String(fnConfig.options.retries.maxAttempts);
      }
      if (fnConfig.options.retries?.initialIntervalMs !== undefined) {
        config.initial_interval_ms = String(fnConfig.options.retries.initialIntervalMs);
      }
      if (fnConfig.options.retries?.maxIntervalMs !== undefined) {
        config.max_interval_ms = String(fnConfig.options.retries.maxIntervalMs);
      }
      if (fnConfig.options.backoff?.type) {
        config.backoff_type = fnConfig.options.backoff.type;
      }
      if (fnConfig.options.backoff?.multiplier !== undefined) {
        config.backoff_multiplier = String(fnConfig.options.backoff.multiplier);
      }
      if (fnConfig.options.timeout_ms !== undefined) {
        config.timeout_ms = String(fnConfig.options.timeout_ms);
      }

      components.push({ name, componentType: 'function', config, metadata: {} });
    }

    // Workflows (auto-discover from registry)
    for (const [name] of WorkflowRegistry.all()) {
      components.push({ name, componentType: 'workflow', config: {}, metadata: {} });
    }

    // Tools (auto-discover from registry)
    for (const [name] of ToolRegistry.all()) {
      components.push({ name, componentType: 'tool', config: {}, metadata: {} });
    }

    // Agents (explicitly registered via registerAgents)
    for (const [name] of this.agents) {
      components.push({ name, componentType: 'agent', config: {}, metadata: {} });
    }

    const counts = {
      function: components.filter(c => c.componentType === 'function').length,
      workflow: components.filter(c => c.componentType === 'workflow').length,
      tool: components.filter(c => c.componentType === 'tool').length,
      agent: components.filter(c => c.componentType === 'agent').length,
    };
    const summary = Object.entries(counts).filter(([, n]) => n > 0).map(([t, n]) => `${n} ${t}(s)`).join(', ');
    console.log(`📦 Registered components: ${summary || 'none'}`);

    await this.nativeWorker.setComponents(components);

    // Set message handler
    this.nativeWorker.setMessageHandler(this.handleMessage.bind(this));

    console.log('✓ Message handler configured');
    console.log('🔗 Connecting to platform...\n');

    // Run the worker (this will block until shutdown)
    await this.nativeWorker.run();
  }
}

/**
 * Detect current JavaScript runtime
 */
export function getRuntime(): 'node' | 'bun' | 'deno' | 'edge' | 'unknown' {
  // @ts-ignore
  if (typeof process !== 'undefined' && process.versions?.node) {
    // @ts-ignore
    if (typeof Bun !== 'undefined') return 'bun';
    // @ts-ignore
    if (typeof Deno !== 'undefined') return 'deno';
    return 'node';
  }
  // @ts-ignore
  if (typeof EdgeRuntime !== 'undefined') return 'edge';
  return 'unknown';
}

/**
 * Check platform connectivity
 */
export async function checkPlatformConnectivity(coordinatorUrl?: string): Promise<boolean> {
  try {
    const native = loadNativeBindings();
    const url = coordinatorUrl || process.env.AGNT5_COORDINATOR_ENDPOINT || 'http://localhost:34186';
    return await native.checkPlatformConnectivity(url);
  } catch (error) {
    console.error('Platform connectivity check failed:', error);
    return false;
  }
}
