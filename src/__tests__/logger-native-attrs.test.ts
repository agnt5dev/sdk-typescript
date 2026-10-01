import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * ctx.logger attributes reach the NAPI bridge as strings (AGNT5-1416).
 *
 * The native `logFromTypescript` takes `HashMap<String, String>`; handing it a
 * number, boolean, array, object or null rejects the whole call, which used to
 * fail the run. Every logger now encodes non-string values first, and a
 * rejected record is dropped instead of escaping into the handler.
 */

const bridge = vi.fn();
vi.mock('#native-loader', () => {
  const bindings = {
    logFromTypescript: bridge,
    StateManager: class {},
    Span: {
      create: () => ({
        setAttribute: () => {},
        addEvent: () => {},
        recordError: () => {},
      }),
    },
  };
  return {
    getLoadedNativeBindings: () => bindings,
    tryLoadNativeBindings: () => bindings,
    loadNativeBindings: () => bindings,
  };
});

const { Worker } = await import('../worker.js');
const { FunctionRegistry, fn } = await import('../function.js');
const { ContextImpl } = await import('../context.js');
const { PlatformContext } = await import('../platform-context.js');
const { ContextLogger, setLogLevel, toNativeLogAttrs } = await import('../logging.js');

const RUN_ID = '01a05cd2-591a-7f51-be2a-4d7d5e7cc1ba';

const MIXED_ATTRS = {
  label: 'plain',
  count: 42,
  ratio: 0.5,
  ok: true,
  tags: ['a', 'b'],
  nested: { k: 1 },
  missing: null,
};

const ENCODED_ATTRS = {
  label: 'plain',
  count: '42',
  ratio: '0.5',
  ok: 'true',
  tags: '["a","b"]',
  nested: '{"k":1}',
  missing: 'null',
};

/** The attributes argument of the bridge call whose message matches. */
function attrsFor(pattern: RegExp): Record<string, unknown> | null | undefined {
  return bridge.mock.calls.find((c) => pattern.test(String(c[1])))?.[5];
}

function expectAllStrings(attrs: Record<string, unknown> | null | undefined): void {
  expect(attrs).toBeTruthy();
  for (const [key, value] of Object.entries(attrs!)) {
    expect(typeof value, `attribute ${key}`).toBe('string');
  }
}

beforeEach(() => {
  bridge.mockReset();
  FunctionRegistry.clear();
  setLogLevel('DEBUG');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('toNativeLogAttrs', () => {
  it('encodes every non-string value and passes strings through', () => {
    expect(toNativeLogAttrs(MIXED_ATTRS)).toEqual(ENCODED_ATTRS);
  });

  it('drops undefined values and returns null when nothing is left', () => {
    expect(toNativeLogAttrs({ gone: undefined })).toBeNull();
    expect(toNativeLogAttrs(undefined)).toBeNull();
    expect(toNativeLogAttrs({})).toBeNull();
  });

  it('never throws on values JSON cannot encode', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const attrs = toNativeLogAttrs({
      circular,
      big: 10n,
      err: new Error('boom'),
      fn: () => 1,
    });
    expectAllStrings(attrs);
    expect(attrs).toMatchObject({ big: '10', err: 'Error: boom' });
  });
});

describe('ctx.logger in a dispatched run', () => {
  it('hands the bridge only string attributes and the run completes', async () => {
    fn('logs_mixed_attrs').run(async (ctx: any) => {
      ctx.logger.info('mixed attrs', MIXED_ATTRS);
      return { ok: true };
    });

    const worker = new Worker('logger-attrs', { serviceVersion: '0.1.0' });
    await (worker as any).processMessage({
      invocationId: RUN_ID,
      componentName: 'logs_mixed_attrs',
      componentType: 'function',
      inputJson: '{}',
      metadata: { run_id: RUN_ID },
    });

    expect(attrsFor(/^mixed attrs$/)).toEqual(ENCODED_ATTRS);
    expect(bridge.mock.calls.some((c) => /run\.completed/.test(String(c[1])))).toBe(true);
    expect(bridge.mock.calls.some((c) => /run\.failed/.test(String(c[1])))).toBe(false);
  });

  it('drops a record the bridge rejects instead of failing the run', async () => {
    bridge.mockImplementation((_level: string, message: string) => {
      if (message === 'rejected') throw new Error('Failed to convert napi value');
    });
    fn('logs_rejected').run(async (ctx: any) => {
      ctx.logger.info('rejected', { n: 1 });
      return { ok: true };
    });

    const worker = new Worker('logger-attrs', { serviceVersion: '0.1.0' });
    await (worker as any).processMessage({
      invocationId: RUN_ID,
      componentName: 'logs_rejected',
      componentType: 'function',
      inputJson: '{}',
      metadata: { run_id: RUN_ID },
    });

    expect(bridge.mock.calls.some((c) => /run\.completed/.test(String(c[1])))).toBe(true);
    expect(bridge.mock.calls.some((c) => /run\.failed/.test(String(c[1])))).toBe(false);
  });
});

describe('other loggers share the encoding', () => {
  it('ContextImpl.logger', () => {
    new ContextImpl('inv-1', RUN_ID, 0, 'svc').logger.info('context impl', MIXED_ATTRS);
    expect(attrsFor(/^context impl$/)).toEqual(ENCODED_ATTRS);
  });

  it('PlatformContext.logger', () => {
    new PlatformContext('inv-1', RUN_ID, 0, 'svc').logger.warn('platform ctx', MIXED_ATTRS);
    expect(attrsFor(/^platform ctx$/)).toEqual(ENCODED_ATTRS);
  });

  it('ContextLogger', () => {
    new ContextLogger('mod', { attrs: { base: 'x' } }).info('context logger', MIXED_ATTRS);
    expect(attrsFor(/context logger$/)).toEqual({ base: 'x', ...ENCODED_ATTRS });
  });

  it('a throwing bridge never escapes a logger call', () => {
    bridge.mockImplementation(() => {
      throw new Error('Failed to convert napi value');
    });
    expect(() => new ContextImpl('inv-1', RUN_ID, 0, 'svc').logger.error('x', { n: 1 })).not.toThrow();
    expect(() => new PlatformContext('inv-1', RUN_ID, 0, 'svc').logger.error('x', { n: 1 })).not.toThrow();
    expect(() => new ContextLogger('mod').error('x', { n: 1 })).not.toThrow();
  });
});
