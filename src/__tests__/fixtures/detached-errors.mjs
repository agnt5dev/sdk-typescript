import { Worker } from '../../../dist/worker.js';
import { workflow } from '../../../dist/workflow.js';
const print = console.log;
console.log = () => {};
const worker = new Worker('containment');
const second = new Worker('containment-two');
const listeners = [process.listenerCount('unhandledRejection'), process.listenerCount('uncaughtException')];
workflow('broken', async () => {
  setTimeout(() => {
    const error = new TypeError('detached failure');
    if (process.argv[2] === 'exception') throw error;
    Promise.reject(error);
  }, 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  return 'unexpected-success';
});
workflow('healthy', async () => {
  await new Promise(resolve => setTimeout(resolve, 50));
  return 'healthy';
});
const outcomes = await Promise.all(['broken', 'healthy'].map(componentName => worker.processMessage({
  invocationId: componentName, componentName, componentType: 'workflow', inputJson: '{}',
  metadata: { run_id: componentName, dispatch_mode: 'pull' },
}).then(JSON.parse)));
worker.disposeProcessGuards();
second.disposeProcessGuards();
print(JSON.stringify({ listeners, outcomes, after: [process.listenerCount('unhandledRejection'), process.listenerCount('uncaughtException')] }));
