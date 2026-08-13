import { beforeEach, expect, it, vi } from 'vitest';

const boot = vi.hoisted(() => ({
  sequence: [] as string[],
  autoEnable: vi.fn(async () => { boot.sequence.push('capture'); }),
}));

vi.mock('../integrations/index', () => ({ autoEnable: boot.autoEnable }));

vi.mock('../native-loader', () => {
  class MockWorker {
    workerId = 'worker-1';
    coordinatorEndpoint = 'http://localhost:34186';
    tenantId = 'project-1';
    deploymentId = 'deployment-1';

    constructor() { boot.sequence.push('worker'); }
    async setComponents() {}
    setMessageHandler() {}
    setCancelHandler() {}
    async run() {}
  }
  const native = {
    initialize: () => { boot.sequence.push('native'); },
    Worker: MockWorker,
    checkPlatformConnectivity: async () => true,
  };
  return {
    getLoadedNativeBindings: () => native,
    loadNativeBindings: () => native,
    tryLoadNativeBindings: () => native,
  };
});

import { Worker } from '../worker.js';

beforeEach(() => {
  boot.sequence.length = 0;
  boot.autoEnable.mockClear();
});

it('auto-enables capture after native initialization and before worker creation', async () => {
  await new Worker('capture-boot').run();
  expect(boot.autoEnable).toHaveBeenCalledOnce();
  expect(boot.sequence.slice(0, 3)).toEqual(['native', 'capture', 'worker']);
});
