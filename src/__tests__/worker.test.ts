import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Worker, getRuntime } from '../worker';
import { FunctionRegistry } from '../function';
import { WorkflowRegistry } from '../workflow';
import { ToolRegistry } from '../tool';
import { ScorerRegistry } from '../scorer';

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
    }) {
      this.coordinatorEndpoint = options.coordinatorEndpoint || 'http://localhost:34186';
      this.tenantId = options.tenantId || 'project-123';
      this.deploymentId = options.deploymentId || 'deployment-123';
    }

    async setComponents(_components: unknown[]): Promise<void> {}

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
    loadNativeBindings: () => native,
    tryLoadNativeBindings: () => native,
  };
});

let originalDashboardURL: string | undefined;

beforeEach(() => {
  originalDashboardURL = process.env.AGNT5_DASHBOARD_URL;
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
  vi.restoreAllMocks();
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
});

describe('getRuntime', () => {
  it('should detect runtime', () => {
    const runtime = getRuntime();
    expect(runtime).toMatch(/node|bun|deno|edge|unknown/);
  });
});
