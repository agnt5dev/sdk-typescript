import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Failed runs must log a `run.failed` line through the run logger (AGNT5-1073).
 *
 * The failure path used to carry only `console.error`, which is not bridged to
 * OTLP, so a failed run's logs stopped after `run.started` and the error text
 * never reached the control plane. `get_run_logs` returned a run that began and
 * then went silent. These pin the line, its content, and that both dispatch
 * modes emit it.
 */

// Capture everything that reaches the NAPI log bridge. Both ContextImpl.logger
// and ContextLogger resolve their log fn through this module at call time.
const bridge = vi.fn();
vi.mock('#native-loader', () => ({
  getLoadedNativeBindings: () => ({ logFromTypescript: bridge }),
  tryLoadNativeBindings: () => ({ logFromTypescript: bridge }),
  loadNativeBindings: () => ({ logFromTypescript: bridge }),
}));

const { Worker } = await import('../worker.js');
const { FunctionRegistry, fn } = await import('../function.js');
const { setLogLevel } = await import('../logging.js');

const RUN_ID = '01a05cd2-7c90-7412-a9ee-81e2d128c54c';

/** Log records that reached the bridge, as [level, message] pairs. */
function records(): Array<[string, string]> {
  return bridge.mock.calls.map((c) => [String(c[0]), String(c[1])]);
}

function lineMatching(pattern: RegExp): [string, string] | undefined {
  return records().find(([, message]) => pattern.test(message));
}

function dispatch(componentName: string, metadata: Record<string, string> = {}) {
  const worker = new Worker('kitchen-sink', { serviceVersion: '0.1.0' });
  return (worker as any).processMessage({
    invocationId: RUN_ID,
    componentName,
    componentType: 'function',
    inputJson: '{}',
    metadata: { run_id: RUN_ID, ...metadata },
  });
}

describe('run.failed logging', () => {
  beforeEach(() => {
    bridge.mockClear();
    FunctionRegistry.clear();
    setLogLevel('DEBUG');
  });

  it('logs run.failed with the error message when a handler throws', async () => {
    fn('ks_fail_with').run(async () => {
      throw new Error('Invalid input: bad value');
    });

    await dispatch('ks_fail_with');

    const failed = lineMatching(/run\.failed/);
    expect(failed, `no run.failed line in ${JSON.stringify(records())}`).toBeDefined();

    const [level, message] = failed!;
    expect(level).toBe('ERROR');
    expect(message).toContain('Invalid input: bad value');
    expect(message).toContain(`run_id=${RUN_ID}`);
    expect(message).toContain('ks_fail_with');
  });

  it('logs run.failed on pull dispatch too', async () => {
    // The runFailed journal event is gated behind !isPullDispatch; the log line
    // must not be, or pull-mode workers lose their failures entirely.
    fn('ks_fail_with').run(async () => {
      throw new Error('boom');
    });

    await dispatch('ks_fail_with', { dispatch_mode: 'pull' });

    expect(lineMatching(/run\.failed/)).toBeDefined();
  });

  it('still logs run.completed on the success path', async () => {
    // run.failed mirrors run.completed; neither should drift away alone.
    fn('ks_noop').run(async () => ({ ok: true }));

    await dispatch('ks_noop');

    expect(lineMatching(/run\.completed/)).toBeDefined();
    expect(lineMatching(/run\.failed/)).toBeUndefined();
  });

  it('logs run.failed when the throw beats context creation', async () => {
    // A malformed inputJson throws before ctx exists, so there is no run logger
    // to fall back on. Those failures still have to be attributable.
    fn('ks_noop').run(async () => ({ ok: true }));

    const worker = new Worker('kitchen-sink', { serviceVersion: '0.1.0' });
    await (worker as any).processMessage({
      invocationId: RUN_ID,
      componentName: 'ks_noop',
      componentType: 'function',
      inputJson: '{not json',
      metadata: { run_id: RUN_ID },
    });

    const failed = lineMatching(/run\.failed/);
    expect(failed, `no run.failed line in ${JSON.stringify(records())}`).toBeDefined();
    const call = bridge.mock.calls.find((c) => /run\.failed/.test(String(c[1])));
    expect(call?.[2]).toBe(RUN_ID);
  });

  it('attributes the failure to the run', async () => {
    // The run id is what get_run_logs filters on; a line without it is
    // invisible to the endpoint even though it reached the bridge.
    fn('ks_fail_with').run(async () => {
      throw new Error('boom');
    });

    await dispatch('ks_fail_with');

    const call = bridge.mock.calls.find((c) => /run\.failed/.test(String(c[1])));
    expect(call?.[2]).toBe(RUN_ID);
  });
});
