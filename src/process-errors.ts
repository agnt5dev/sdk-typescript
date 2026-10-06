import { createHook } from 'node:async_hooks';
import { writeSync } from 'node:fs';
import { getCurrentContext } from './async-context.js';

type ErrorRoute = (error: unknown) => boolean;
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
  return route?.(error) === true;
}
const rejection = (error: unknown, promise: Promise<unknown>) => {
  if (report(error, promise) || process.listenerCount('unhandledRejection') > 1) return;
  // With no application rejection handler, Node promotes the rejection to
  // an uncaught exception. This also lets application exception handlers run.
  process.nextTick(() => { throw error instanceof Error ? error : new Error(String(error)); });
};
const exception = (error: Error) => {
  if (report(error) || process.listenerCount('uncaughtException') > 1) return;
  // Our listener overrides Node's default; restore its stack + exit behavior
  // when no active dispatch or application handler owns this exception.
  try { writeSync(2, `${error.stack ?? error}\n`); }
  finally { process.exit(1); }
};

/** One set of process guards shared by all workers; user listeners are retained. */
export function installProcessErrorGuards(): () => void {
  if (typeof process === 'undefined' || typeof process.on !== 'function') return () => {};
  if (users++ === 0) {
    hook = makeHook();
    hook.enable();
    // Inspect application handlers before once() listeners remove themselves.
    process.prependListener('unhandledRejection', rejection);
    process.prependListener('uncaughtException', exception);
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
