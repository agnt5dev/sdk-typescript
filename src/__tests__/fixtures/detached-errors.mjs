import { Worker } from '../../../dist/worker.js';
import { workflow } from '../../../dist/workflow.js';
const print = console.log;
console.log = () => {};
const worker = new Worker('containment');
const second = new Worker('containment-two');
const terminals = [];
worker.nativeWorker = {
  queueEvent() {},
  async emitCheckpoint(runId, type) {
    if (runId === 'broken' && ['run.completed', 'workflow.completed', 'workflow.paused'].includes(type)) terminals.push(type);
  },
};
const listeners = [process.listenerCount('unhandledRejection'), process.listenerCount('uncaughtException')];
const mode = process.argv[2];
workflow('broken', async ctx => {
  const fail = () => {
    const error = new TypeError('detached failure');
    if (mode.startsWith('exception')) throw error;
    Promise.reject(error);
  };
  if (mode.startsWith('exception') || !mode.includes('-')) setTimeout(fail, 0);
  else fail();
  if (mode.endsWith('-pause')) await ctx.waitForSignal('approval');
  if (mode.endsWith('-hitl')) await ctx.waitForUser('Continue?');
  if (!mode.includes('-')) await new Promise(resolve => setTimeout(resolve, 30));
  return 'unexpected-success';
});
let agentClosed = false;
worker.registerAgents([{
  name: 'broken',
  async *stream() {
    try {
      setTimeout(() => Promise.reject(new TypeError('detached failure')), 0);
      await new Promise(resolve => setTimeout(resolve, 30));
      yield { eventType: 'agent.started' };
    } finally { agentClosed = true; }
  },
}]);
workflow('healthy', async () => {
  await new Promise(resolve => setTimeout(resolve, 50));
  return 'healthy';
});
const outcomes = await Promise.all(['broken', 'healthy'].map(componentName => worker.processMessage({
  invocationId: componentName, componentName, componentType: componentName === 'broken' && mode === 'agent-rejection' ? 'agent' : 'workflow', inputJson: '{}',
  metadata: { run_id: componentName, dispatch_mode: mode.endsWith('-hitl') ? 'push' : 'pull' },
}).then(JSON.parse)));
worker.disposeProcessGuards();
second.disposeProcessGuards();
print(JSON.stringify({ listeners, outcomes, terminals, agentClosed, after: [process.listenerCount('unhandledRejection'), process.listenerCount('uncaughtException')] }));
