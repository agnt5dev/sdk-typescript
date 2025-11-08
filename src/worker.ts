import type { WorkerOptions, Context } from './types.js';
import { FunctionRegistry } from './function.js';
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
      join(__dirname, '../../native/agnt5-sdk-native.darwin-arm64.node'),  // From dist/src
      join(__dirname, '../native/agnt5-sdk-native.darwin-arm64.node'),     // From src
      join(__dirname, '../../native/agnt5-sdk-native.linux-x64.node'),     // Linux
      join(__dirname, '../native/agnt5-sdk-native.linux-x64.node'),        // Linux
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

  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.state.has(key) ? this.state.get(key) : defaultValue;
  }

  set<T>(key: string, value: T): void {
    this.state.set(key, value);
  }

  delete(key: string): void {
    this.state.delete(key);
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

  /**
   * Handle incoming execution requests from the platform
   */
  private async handleMessage(message: {
    invocationId: string;
    componentName: string;
    componentType: string;
    inputJson: string;
    metadata: Record<string, string>;
  }): Promise<{ invocationId: string; outputJson?: string; error?: string } | null> {
    try {
      console.log(`📨 Received ${message.componentType} execution: ${message.componentName}`);

      // Parse input data
      const inputData = JSON.parse(message.inputJson);

      // Create context
      const ctx = new SimpleContext(
        message.invocationId,
        message.metadata.run_id || message.invocationId,
        0, // attempt
        this.serviceName
      );

      // Route to appropriate handler based on component type
      if (message.componentType === 'function') {
        const fn = FunctionRegistry.get(message.componentName);
        if (!fn) {
          throw new Error(`Function not found: ${message.componentName}`);
        }

        // Execute the function handler
        const result = await fn.handler(ctx, ...inputData.args);

        // Return success response
        return {
          invocationId: message.invocationId,
          outputJson: JSON.stringify(result),
        };
      } else {
        throw new Error(`Component type not yet supported: ${message.componentType}`);
      }
    } catch (error) {
      console.error(`❌ Execution failed:`, error);
      return {
        invocationId: message.invocationId,
        error: (error as Error).message,
      };
    }
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

    // Get all registered components
    const functions = FunctionRegistry.getAll();
    console.log(`📦 Registered components: ${functions.length} function(s)`);

    // Register components with native worker
    const components = functions.map(([name, config]) => ({
      name,
      componentType: 'function',
      config: {},
      metadata: {},
    }));

    this.nativeWorker.setComponents(components);

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
