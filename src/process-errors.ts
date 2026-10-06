import { createHook } from 'node:async_hooks';
import { getCurrentContext } from './async-context.js';

type ErrorRoute = (error: unknown) => void;
const promises = new WeakMap<object, ErrorRoute>();
let users = 0;
let hook: ReturnType<typeof createHook> | undefined;
function makeHook() { return createHook({
  init(_id, type, _trigger, resource) {
    const route = getCurrentContext()?.onDetachedError;
    if (type === 'PROMISE' && route) promises.set(resource, route);
  },
}); }
function report(error: unknown, promise?: Promise<unknown>) {
  const route = (promise && promises.get(promise)) ?? getCurrentContext()?.onDetachedError;
  if (route) route(error);
  else console.error('Worker process error outside an active run:', error);
}
const rejection = (error: unknown, promise: Promise<unknown>) => report(error, promise);
const exception = (error: Error) => report(error);

/** One set of process guards shared by all workers; user listeners are retained. */
export function installProcessErrorGuards(): () => void {
  if (typeof process === 'undefined' || typeof process.on !== 'function') return () => {};
  if (users++ === 0) {
    hook = makeHook();
    hook.enable();
    process.on('unhandledRejection', rejection);
    process.on('uncaughtException', exception);
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (--users === 0) {
      process.off('unhandledRejection', rejection);
      process.off('uncaughtException', exception);
      hook?.disable();
      hook = undefined;
    }
  };
}
