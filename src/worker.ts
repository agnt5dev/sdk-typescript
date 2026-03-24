import type { WorkerOptions, Context } from './types.js';
import { FunctionRegistry } from './function.js';
import { WorkflowRegistry } from './workflow.js';
import { ToolRegistry } from './tool.js';
import { Agent } from './agent.js';
import { runWithContext } from './async-context.js';
import { WaitingForUserInputError } from './errors.js';
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
  constructor(
    public readonly invocationId: string,
    public readonly runId: string,
    public readonly attempt: number,
    public readonly serviceName: string,
    private state: Map<string, any> = new Map()
  ) {}

  get logger() {
    return {
      info: (message: string, meta?: Record<string, any>) => {
        console.log(`[INFO] ${message}`, meta || {});
      },
      error: (message: string, meta?: Record<string, any>) => {
        console.error(`[ERROR] ${message}`, meta || {});
      },
      warn: (message: string, meta?: Record<string, any>) => {
        console.warn(`[WARN] ${message}`, meta || {});
      },
      debug: (message: string, meta?: Record<string, any>) => {
        console.debug(`[DEBUG] ${message}`, meta || {});
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

  async step<T>(stepName: string, fn: () => T | Promise<T>): Promise<T> {
    // TODO: Implement durable checkpointing
    return await fn();
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

  /**
   * Register agents that can be dispatched by the worker.
   */
  registerAgents(agents: Agent[]): void {
    for (const agent of agents) {
      this.agents.set(agent.name, agent);
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
        try {
          console.log(`📨 Received ${message.componentType} execution: ${message.componentName}`);

          // Parse input data
          const inputData = JSON.parse(message.inputJson);

          // Create context
          const ctx = new SimpleContext(
            message.invocationId,
            runId,
            parseInt(message.metadata?.attempt || '0', 10),
            this.serviceName
          );

          let result: any;

          switch (message.componentType) {
            case 'function': {
              const fn = FunctionRegistry.get(message.componentName);
              if (!fn) {
                throw new Error(`Function not found: ${message.componentName}`);
              }
              // Platform sends input as a JSON dict (like Python's **kwargs).
              // Pass the whole dict as a single argument to the handler.
              result = await fn.handler(ctx, inputData);
              break;
            }

            case 'workflow': {
              const wf = WorkflowRegistry.get(message.componentName);
              if (!wf) {
                throw new Error(`Workflow not found: ${message.componentName}`);
              }
              result = await wf.handler(ctx, inputData);
              break;
            }

            case 'agent': {
              const agent = this.agents.get(message.componentName);
              if (!agent) {
                throw new Error(`Agent not found: ${message.componentName}`);
              }
              const agentResult = await agent.run(inputData.prompt || inputData.message || JSON.stringify(inputData), ctx);
              result = agentResult.output;
              break;
            }

            case 'tool': {
              const tool = ToolRegistry.get(message.componentName);
              if (!tool) {
                throw new Error(`Tool not found: ${message.componentName}`);
              }
              result = await tool.invoke(ctx, inputData);
              break;
            }

            default:
              throw new Error(`Unknown component type: ${message.componentType}`);
          }

          return JSON.stringify({
            invocationId: message.invocationId,
            outputJson: JSON.stringify(result),
          });
        } catch (error) {
          // HITL: propagate pause signal to platform
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
    for (const [name] of FunctionRegistry.getAll()) {
      components.push({ name, componentType: 'function', config: {}, metadata: {} });
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
