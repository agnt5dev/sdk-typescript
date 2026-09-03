import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Worker, getRuntime } from '../worker';
import { fn, FunctionRegistry } from '../function';
import { workflow, WorkflowRegistry } from '../workflow';
import { tool, ToolRegistry } from '../tool';
import {
  BUILTIN_DETERMINISTIC_SCORER_NAMES,
  BUILTIN_JUDGE_SCORER_NAMES,
  ScorerRegistry,
  ScorerResult,
  scorer,
} from '../scorer';

vi.mock('../native-loader', () => {
  class MockNativeWorker {
    workerId = 'worker-123';
    coordinatorEndpoint: string;
    tenantId: string;
    deploymentId: string;

    constructor(options: {
      coordinatorEndpoint?: string;
      tenantId?: string;
      deploymentId?: string;
      maxConcurrency?: number;
    }) {
      const globalState = globalThis as typeof globalThis & {
        __agnt5NativeWorkerOptions?: unknown[];
      };
      globalState.__agnt5NativeWorkerOptions ||= [];
      globalState.__agnt5NativeWorkerOptions.push(options);
      this.coordinatorEndpoint = options.coordinatorEndpoint || 'http://localhost:34186';
      this.tenantId = options.tenantId || 'project-123';
      this.deploymentId = options.deploymentId || 'deployment-123';
    }

    async setComponents(components: unknown[]): Promise<void> {
      (globalThis as any).__agnt5RegisteredComponents = components;
    }

    setMessageHandler(_handler: unknown): void {}

    setCancelHandler(_handler: unknown): void {}

    async run(): Promise<void> {}
  }

  const native = {
    initialize: (_serviceName: string, _serviceVersion: string) => {},
    Worker: MockNativeWorker,
    checkPlatformConnectivity: async (_url: string) => true,
  };

  return {
    getLoadedNativeBindings: () => null,
    loadNativeBindings: () => native,
    tryLoadNativeBindings: () => native,
  };
});

let originalDashboardURL: string | undefined;
const workerEnvKeys = [
  'AGNT5_PROJECT_ID',
  'AGNT5_DEPLOYMENT_ID',
  'AGNT5_WORKER_MODE',
  'AGNT5_MIN_SLOTS',
  'AGNT5_MAX_SLOTS',
  'AGNT5_CLAIM_TIMEOUT_MS',
] as const;
let originalWorkerEnv: Partial<Record<(typeof workerEnvKeys)[number], string>>;

function nativeWorkerOptions(): any[] {
  return ((globalThis as any).__agnt5NativeWorkerOptions || []) as any[];
}

beforeEach(() => {
  originalDashboardURL = process.env.AGNT5_DASHBOARD_URL;
  originalWorkerEnv = {};
  for (const key of workerEnvKeys) {
    originalWorkerEnv[key] = process.env[key];
  }
  (globalThis as any).__agnt5NativeWorkerOptions = [];
  (globalThis as any).__agnt5RegisteredComponents = [];
  FunctionRegistry.clear();
  WorkflowRegistry.clear();
  ToolRegistry.clear();
  ScorerRegistry.clear();
});

afterEach(() => {
  if (originalDashboardURL === undefined) {
    delete process.env.AGNT5_DASHBOARD_URL;
  } else {
    process.env.AGNT5_DASHBOARD_URL = originalDashboardURL;
  }
  for (const key of workerEnvKeys) {
    const original = originalWorkerEnv[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
  delete (globalThis as any).__agnt5NativeWorkerOptions;
  delete (globalThis as any).__agnt5RegisteredComponents;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('uses the canonical agent session entity key', async () => {
  const fetchMock = vi.fn(async () => new Response(
    JSON.stringify({ state: { messages: [] } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ));
  vi.stubGlobal('fetch', fetchMock);
  const worker = new Worker('test-service');

  await (worker as any)._loadSessionHistory('session-1', 'helper');

  expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
    '/v1/entity/AgentSession/agent:helper:session-1/get',
  );
});

describe('Worker', () => {
  it('should create worker instance', () => {
    const worker = new Worker('test-service');
    expect(worker).toBeDefined();
  });

  it('should accept options', () => {
    const worker = new Worker('test-service', {
      runtime: 'managed',
    });
    expect(worker).toBeDefined();
  });

  it('prints dashboard link from AGNT5_DASHBOARD_URL after the component summary', async () => {
    const dashboardURL = 'https://app.agnt5.com/projects/6106a9b8-b2fa-4896-89d9-16bcceb20c72/components';
    process.env.AGNT5_DASHBOARD_URL = dashboardURL;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const worker = new Worker('test-service');
    await worker.run();

    const messages = logSpy.mock.calls.map((call) => String(call[0]));
    const summaryIndex = messages.findIndex((message) => message.includes('Registered components'));
    const dashboardIndex = messages.findIndex((message) => message === `Dashboard: ${dashboardURL}`);
    const connectingIndex = messages.findIndex((message) => message.includes('Connecting to platform'));

    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(dashboardIndex).toBeGreaterThan(summaryIndex);
    expect(connectingIndex).toBeGreaterThan(dashboardIndex);
  });

  it('omits dashboard link when AGNT5_DASHBOARD_URL is not set', async () => {
    delete process.env.AGNT5_DASHBOARD_URL;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const worker = new Worker('test-service');
    await worker.run();

    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).not.toContain('Dashboard:');
  });

  it('passes worker identity and concurrency options to the native worker', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const worker = new Worker('test-service', {
      tenantId: 'project-abc',
      deploymentId: 'deployment-def',
      maxConcurrency: 24,
    });
    await worker.run();

    expect(nativeWorkerOptions()[0]).toMatchObject({
      tenantId: 'project-abc',
      deploymentId: 'deployment-def',
      maxConcurrency: 24,
    });
  });

  it('passes function, workflow, and tool schemas to native registration', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const locationSchema = {
      type: 'object' as const,
      properties: {
        location: {
          type: 'string' as const,
          description: 'City and country to look up',
        },
      },
      required: ['location'],
    };

    fn('weather').inputSchema(locationSchema).run(async () => ({ ok: true }));
    workflow('travel', async () => ({ ok: true }), { inputSchema: locationSchema });
    tool(
      'lookup',
      { description: 'Look up a location', inputSchema: locationSchema },
      async () => ({ ok: true }),
    );

    await new Worker('test-service').run();

    const components = (globalThis as any).__agnt5RegisteredComponents as any[];
    for (const name of ['weather', 'travel', 'lookup']) {
      const component = components.find((candidate) => candidate.name === name);
      expect(JSON.parse(component.inputSchema)).toEqual(locationSchema);
    }
  });

  it('registers custom scorers and marks only worker-executed built-ins by source', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    scorer('custom_quality')(
      async () => new ScorerResult({ score: 1, passed: true }),
    );

    await new Worker('test-service').run();

    const components = (globalThis as any).__agnt5RegisteredComponents as any[];
    const scorers = components.filter((component) => component.componentType === 'scorer');
    expect(scorers.map((component) => component.name).sort()).toEqual(
      [
        ...BUILTIN_DETERMINISTIC_SCORER_NAMES,
        ...BUILTIN_JUDGE_SCORER_NAMES,
        'custom_quality',
      ].sort(),
    );

    for (const name of [
      ...BUILTIN_DETERMINISTIC_SCORER_NAMES,
      ...BUILTIN_JUDGE_SCORER_NAMES,
    ]) {
      const component = scorers.find((candidate) => candidate.name === name);
      expect(component.metadata).toMatchObject({ source: 'agnt5_builtin' });
      expect(component.metadata).not.toHaveProperty('agnt5_builtin');
      expect(component.metadata).not.toHaveProperty('agnt5.builtin');
      expect(component.config).not.toHaveProperty('builtin');
    }

    const custom = scorers.find((component) => component.name === 'custom_quality');
    expect(custom.metadata).not.toHaveProperty('source');
    expect(custom.config).not.toHaveProperty('builtin');

    const promptExecutor = components.find(
      (component) => component.name === 'agnt5_prompt_executor',
    );
    expect(promptExecutor.metadata).toMatchObject({ source: 'agnt5_builtin' });
    expect(promptExecutor.metadata).not.toHaveProperty('agnt5_builtin');
    expect(promptExecutor.config).not.toHaveProperty('builtin');
  });

  it('maps pull worker options to sdk-core long polling environment', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const worker = new Worker('test-service', {
      tenantId: 'project-pull',
      deploymentId: 'deployment-pull',
      workerMode: 'pull',
      minSlots: 2,
      maxSlots: 10,
      claimTimeoutMs: 120000,
    });
    await worker.run();

    expect(process.env.AGNT5_PROJECT_ID).toBe('project-pull');
    expect(process.env.AGNT5_DEPLOYMENT_ID).toBe('deployment-pull');
    expect(process.env.AGNT5_WORKER_MODE).toBe('pull');
    expect(process.env.AGNT5_MIN_SLOTS).toBe('2');
    expect(process.env.AGNT5_MAX_SLOTS).toBe('10');
    expect(process.env.AGNT5_CLAIM_TIMEOUT_MS).toBe('120000');
  });

  it('keeps enableJobQueue as a parked pull compatibility alias', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const worker = new Worker('test-service', {
      enableJobQueue: true,
      jobQueueConcurrency: 7,
    });
    await worker.run();

    expect(process.env.AGNT5_WORKER_MODE).toBe('pull');
    expect(process.env.AGNT5_MAX_SLOTS).toBe('7');
  });

  it('rejects disabling long polling for pull workers', async () => {
    const worker = new Worker('test-service', {
      workerMode: 'pull',
      parkedPolling: false,
    });

    await expect(worker.run()).rejects.toThrow('pull workers always use long polling');
  });
});

describe('getRuntime', () => {
  it('should detect runtime', () => {
    const runtime = getRuntime();
    expect(runtime).toMatch(/node|bun|deno|edge|unknown/);
  });
});
