import type { WorkerOptions } from './types.js';
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

    // TODO: Implement actual worker.run() with message handling
    // For now, just show configuration
    console.log('✓ Worker initialized successfully');
    console.log('⚠️  Worker.run() not yet implemented - platform connectivity coming soon');
    console.log('   Current status: Configuration loaded, ready for platform integration');
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
