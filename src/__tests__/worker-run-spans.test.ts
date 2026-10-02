import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TypeScript runs must record spans for the run, its steps, functions and
 * tools (AGNT5-1320).
 *
 * The worker used to open no span on the dispatch path, so a TypeScript run's
 * trace came back with zero spans even though its logs carried the trace id.
 * These tests mock the native `Span` binding and pin which spans are opened,
 * how they nest under the dispatch traceparent, and how failures and
 * suspensions are recorded.
 */

type RecordedSpan = {
  name: string;
  componentType: string;
  parentTraceId: string | null;
  parentSpanId: string | null;
  attributes: Record<string, string>;
  traceId: string;
  spanId: string;
  error: string | null;
  ended: boolean;
  sampled: boolean | undefined;
};

const spans: RecordedSpan[] = [];

class FakeNativeSpan {
  constructor(readonly record: RecordedSpan) {}
  get traceId() { return this.record.traceId; }
  get spanId() { return this.record.spanId; }
  setAttribute(key: string, value: string) { this.record.attributes[key] = value; }
  recordError(message: string) { this.record.error = message; }
  end() { this.record.ended = true; }

  static create(
    name: string,
    componentType: string,
    parentTraceId: string | null,
    parentSpanId: string | null,
    attributes: Record<string, string> | null,
    sampled?: boolean,
  ) {
    const record: RecordedSpan = {
      sampled,
      name,
      componentType,
      parentTraceId,
      parentSpanId,
      attributes: { ...(attributes ?? {}) },
      traceId: parentTraceId ?? 'f'.repeat(32),
      spanId: (spans.length + 1).toString(16).padStart(16, '0'),
      error: null,
      ended: false,
    };
    spans.push(record);
    return new FakeNativeSpan(record);
  }
}

const bindings = { Span: FakeNativeSpan, logFromTypescript: vi.fn() };
vi.mock('#native-loader', () => ({
  getLoadedNativeBindings: () => bindings,
  tryLoadNativeBindings: () => bindings,
  loadNativeBindings: () => bindings,
}));

const { Worker } = await import('../worker.js');
const { FunctionRegistry, fn } = await import('../function.js');
const { WorkflowRegistry, workflow } = await import('../workflow.js');
const { ToolRegistry, tool } = await import('../tool.js');
const { EventEmitter } = await import('../event-emitter.js');
const { SuspensionRequestedError } = await import('../errors.js');
const { Span, finishSpan, withSpan } = await import('../tracing.js');

const RUN_ID = '01a05cd2-7c90-7412-a9ee-81e2d128c54c';
const TRACE_ID = '01a05cd2591f7be08bb33d7df5f1de07';
const DISPATCH_SPAN_ID = 'd8e314d6ce264a7b';

let currentWorker: any;

async function dispatch(
  name: string,
  componentType = 'workflow',
  metadata: Record<string, string> = { traceparent: `00-${TRACE_ID}-${DISPATCH_SPAN_ID}-01` },
) {
  const worker = new Worker('orders', { serviceVersion: '0.1.0' });
  currentWorker = worker;
  const response = await (worker as any).processMessage({
    invocationId: RUN_ID,
    componentName: name,
    componentType,
    inputJson: JSON.stringify({ orderId: 'o-1', sku: 'sku-1' }),
    metadata: { run_id: RUN_ID, ...metadata },
  });
  return JSON.parse(response);
}

const dispatchWorkflow = (name: string) => dispatch(name);

function span(name: string): RecordedSpan {
  const found = spans.find((s) => s.name === name);
  if (!found) throw new Error(`no span named ${name}; got ${spans.map((s) => s.name).join(', ')}`);
  return found;
}

describe('worker run spans', () => {
  beforeEach(() => {
    spans.length = 0;
    FunctionRegistry.clear();
    WorkflowRegistry.clear();
    ToolRegistry.clear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  function registerOrderWorkflow(name: string, inventoryDown: boolean) {
    const validateOrder = fn('validate_order').run(async (_ctx, order: { orderId: string }) => ({
      valid: true,
      orderId: order.orderId,
    }));
    const lookupInventory = tool('lookup_inventory', { description: 'Stock lookup' }, async () => {
      if (inventoryDown) throw new Error('inventory service unavailable');
      return { available: 3 };
    });
    workflow(name, async (ctx, order: { orderId: string; sku: string }) => {
      await validateOrder(ctx, order);
      return await ctx.step('check_stock', () => lookupInventory(ctx, { sku: order.sku }));
    });
  }

  it('records a failed tool under its step, inside a failed run span', async () => {
    registerOrderWorkflow('fulfil_order_outage', true);

    const response = await dispatchWorkflow('fulfil_order_outage');
    expect(response.eventType).toBe('run.failed');

    const run = span('workflow.fulfil_order_outage');
    expect(run.parentTraceId).toBe(TRACE_ID);
    expect(run.parentSpanId).toBe(DISPATCH_SPAN_ID);
    expect(run.attributes.run_id).toBe(RUN_ID);
    expect(run.error).toBe('inventory service unavailable');

    const validate = span('function.validate_order');
    expect(validate.parentSpanId).toBe(run.spanId);
    expect(validate.error).toBeNull();

    const step = span('workflow.step.check_stock');
    expect(step.parentSpanId).toBe(run.spanId);
    expect(step.error).toBe('inventory service unavailable');

    const lookup = span('tool.lookup_inventory');
    expect(lookup.parentSpanId).toBe(step.spanId);
    expect(lookup.attributes.run_id).toBe(RUN_ID);
    expect(lookup.error).toBe('inventory service unavailable');

    for (const s of spans) expect(s.traceId).toBe(TRACE_ID);
    expect(spans.every((s) => s.ended)).toBe(true);
  });

  it('records a healthy run without errors', async () => {
    registerOrderWorkflow('fulfil_order', false);

    const response = await dispatchWorkflow('fulfil_order');
    expect(response.eventType).toBe('run.completed');

    expect(spans.map((s) => s.name)).toEqual([
      'workflow.fulfil_order',
      'function.validate_order',
      'workflow.step.check_stock',
      'tool.lookup_inventory',
    ]);
    expect(spans.every((s) => s.ended && s.error === null)).toBe(true);
  });

  it('marks a run paused for user input as suspended, not failed', async () => {
    workflow('approve_order', async (ctx) => ctx.waitForUser('Approve?'));

    const response = await dispatchWorkflow('approve_order');
    expect(response.eventType).toBe('workflow.paused');

    const run = span('workflow.approve_order');
    expect(run.error).toBeNull();
    expect(run.attributes['agnt5.suspended']).toBe('true');
    expect(run.ended).toBe(true);
  });

  it('keeps an unsampled trace unsampled', async () => {
    registerOrderWorkflow('fulfil_unsampled', false);

    await dispatch('fulfil_unsampled', 'workflow', {
      traceparent: `00-${TRACE_ID}-${DISPATCH_SPAN_ID}-00`,
    });

    expect(spans.length).toBe(4);
    expect(spans.every((s) => s.sampled === false)).toBe(true);
  });

  it('continues the loose trace_id / span_id the OSS dispatch path sets', async () => {
    registerOrderWorkflow('fulfil_oss', false);

    await dispatch('fulfil_oss', 'workflow', { trace_id: TRACE_ID, span_id: DISPATCH_SPAN_ID });

    const run = span('workflow.fulfil_oss');
    expect(run.parentTraceId).toBe(TRACE_ID);
    expect(run.parentSpanId).toBe(DISPATCH_SPAN_ID);
  });

  it('records a top-level tool dispatch once', async () => {
    tool('lookup_stock', { description: 'Stock lookup' }, async () => ({ available: 3 }));

    await dispatch('lookup_stock', 'tool');

    expect(spans.map((s) => s.name)).toEqual(['tool.lookup_stock']);
  });

  it('traces a tool called with positional arguments', async () => {
    const reserve = tool('reserve', { description: 'Reserve stock' }, (async (_ctx: unknown, sku: string) => sku) as any);
    workflow('reserve_order', async (ctx) => (reserve as any)(ctx, 'sku-1'));

    await dispatch('reserve_order');

    expect(span('tool.reserve').parentSpanId).toBe(span('workflow.reserve_order').spanId);
  });

  it('ends the run span when flushing events fails', async () => {
    registerOrderWorkflow('fulfil_flush', false);
    const flush = vi.spyOn(EventEmitter.prototype, 'flush').mockRejectedValue(new Error('transport down'));

    await expect(dispatch('fulfil_flush')).rejects.toThrow('transport down');

    const run = span('workflow.fulfil_flush');
    expect(run.ended).toBe(true);
    expect(run.error).toBe('transport down');
    flush.mockRestore();
  });

  it('keeps a function span open while its stream is consumed', async () => {
    const produce = fn('produce').run(async function* () {
      yield 1;
      await withSpan('inside', async () => {});
      yield 2;
    } as any);
    workflow('stream_order', async (ctx) => {
      const out: number[] = [];
      for await (const n of (await produce(ctx)) as any) out.push(n);
      return out;
    });

    const response = await dispatch('stream_order');

    expect(JSON.parse(response.outputJson)).toEqual([1, 2]);
    const fnSpan = span('function.produce');
    expect(span('inside').parentSpanId).toBe(fnSpan.spanId);
    expect(fnSpan.ended).toBe(true);
  });

  it('marks a workerless suspension as suspended, not failed', () => {
    const s = new Span('tool.wait', 'tool');
    finishSpan(s, new SuspensionRequestedError({ runId: RUN_ID, reason: 'sleep' }));
    const recorded = spans[spans.length - 1];
    expect(recorded.error).toBeNull();
    expect(recorded.attributes['agnt5.suspended']).toBe('true');
  });

  it('ignores a traceparent with malformed flags', async () => {
    registerOrderWorkflow('fulfil_bad_flags', false);

    await dispatch('fulfil_bad_flags', 'workflow', {
      traceparent: `00-${TRACE_ID}-${DISPATCH_SPAN_ID}-zz`,
    });

    expect(span('workflow.fulfil_bad_flags').parentTraceId).toBeNull();
  });

  it('marks work aborted by cancellation as cancelled, not failed', async () => {
    const slow = tool('slow_lookup', { description: 'Slow lookup' }, async () => {
      currentWorker.inflight.get(RUN_ID).abort();
      throw new Error('The operation was aborted');
    });
    workflow('cancel_order', async (ctx) => slow(ctx, { sku: 'sku-1' }));

    const response = await dispatch('cancel_order');

    expect(response.eventType).toBe('run.cancelled');
    const lookup = span('tool.slow_lookup');
    expect(lookup.error).toBeNull();
    expect(lookup.attributes['agnt5.cancelled']).toBe('true');
  });

  it('runs stream cleanup inside the function span when the consumer stops early', async () => {
    const produce = fn('produce_early').run(async function* () {
      try {
        yield 1;
        yield 2;
      } finally {
        await withSpan('cleanup', async () => {});
      }
    } as any);
    workflow('early_stop', async (ctx) => {
      for await (const n of (await produce(ctx)) as any) return n;
    });

    await dispatch('early_stop');

    const fnSpan = span('function.produce_early');
    expect(span('cleanup').parentSpanId).toBe(fnSpan.spanId);
    expect(fnSpan.ended).toBe(true);
  });

  it.each([
    `zz-${TRACE_ID}-${DISPATCH_SPAN_ID}-01`,
    `ff-${TRACE_ID}-${DISPATCH_SPAN_ID}-01`,
    `00-${TRACE_ID}-${DISPATCH_SPAN_ID}-01-extra`,
  ])('ignores an invalid traceparent version: %s', async (traceparent) => {
    registerOrderWorkflow('fulfil_bad_version', false);

    await dispatch('fulfil_bad_version', 'workflow', { traceparent });

    expect(span('workflow.fulfil_bad_version').parentTraceId).toBeNull();
  });

  it('records a flush failure over a suspension', async () => {
    workflow('approve_then_flush_fails', async (ctx) => ctx.waitForUser('Approve?'));
    const flush = vi.spyOn(EventEmitter.prototype, 'flush').mockRejectedValue(new Error('transport down'));

    await expect(dispatch('approve_then_flush_fails')).rejects.toThrow('transport down');

    const run = span('workflow.approve_then_flush_fails');
    expect(run.error).toBe('transport down');
    expect(run.attributes['agnt5.suspended']).toBeUndefined();
    flush.mockRestore();
  });

  it('lets a stream handle an injected error inside its span', async () => {
    const produce = fn('produce_recovers').run(async function* () {
      try {
        yield 1;
      } catch {
        await withSpan('recovered', async () => {});
        yield 2;
      }
    } as any);
    workflow('inject_error', async (ctx) => {
      const iterator = ((await produce(ctx)) as any)[Symbol.asyncIterator]();
      await iterator.next();
      const step = await iterator.throw(new Error('consumer error'));
      await iterator.next();
      return step.value;
    });

    const response = await dispatch('inject_error');

    expect(JSON.parse(response.outputJson)).toBe(2);
    const fnSpan = span('function.produce_recovers');
    expect(span('recovered').parentSpanId).toBe(fnSpan.spanId);
    expect(fnSpan.error).toBeNull();
    expect(fnSpan.ended).toBe(true);
  });

  it('ends a function span when its stream cannot be iterated', async () => {
    const broken = fn('broken_stream').run((async () => ({
      [Symbol.asyncIterator]() {
        throw new Error('no iterator');
      },
    })) as any);
    workflow('broken_order', async (ctx) => {
      for await (const _ of (await broken(ctx)) as any) {
        // unreachable
      }
    });

    await dispatch('broken_order');

    const fnSpan = span('function.broken_stream');
    expect(fnSpan.ended).toBe(true);
    expect(fnSpan.error).toBe('no iterator');
  });
});
