import { Worker } from '../../../dist/worker.js';
import { workflow } from '../../../dist/workflow.js';
const print = console.log;
console.log = () => {};
const mode = process.argv[2];
const event = mode.startsWith('rejection') ? 'unhandledRejection' : 'uncaughtException';
const handled = [];
if (mode.includes('user')) {
  const handlerEvent = mode.includes('user-exception') ? 'uncaughtException' : event;
  if (mode.includes('once')) process.once(handlerEvent, error => handled.push(error.message));
  else process.on(handlerEvent, error => handled.push(error.message));
}
const worker = new Worker('outside-errors');
worker.nativeWorker = { queueEvent() {}, async emitCheckpoint() {} };
const fail = () => {
  const error = new TypeError('outside failure');
  if (event === 'unhandledRejection') Promise.reject(error);
  else throw error;
};
if (mode.includes('after')) {
  workflow('settled', async () => { setTimeout(fail, 25); return 'settled'; });
  await worker.processMessage({ invocationId: 'settled', componentName: 'settled', componentType: 'workflow', inputJson: '{}', metadata: { run_id: 'settled', dispatch_mode: 'pull' } });
} else setTimeout(fail, 0);
setTimeout(() => {
  worker.disposeProcessGuards();
  print(JSON.stringify({ survived: true, handled }));
}, 60);
