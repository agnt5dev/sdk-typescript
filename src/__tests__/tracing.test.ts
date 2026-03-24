import { describe, it, expect } from 'vitest';
import { Span, withSpan, spanContext, span, getCurrentSpanInfo } from '../tracing.js';

describe('Tracing', () => {
  describe('Span', () => {
    it('should create a span with name and component type', () => {
      const s = new Span('test-op', 'function');
      expect(s.name).toBe('test-op');
      expect(s.componentType).toBe('function');
      expect(s.traceId).toBeDefined();
      expect(s.spanId).toBeDefined();
      expect(s.parentSpanId).toBeNull();
    });

    it('should inherit traceId from parent', () => {
      const parent = { traceId: 'trace-1', spanId: 'parent-span' };
      const child = new Span('child-op', 'operation', parent);

      expect(child.traceId).toBe('trace-1');
      expect(child.parentSpanId).toBe('parent-span');
      expect(child.spanId).not.toBe('parent-span');
    });

    it('should track attributes and duration', () => {
      const s = new Span('timed-op', 'operation');
      s.setAttribute('key', 'value');
      s.end();

      expect(s.attributes.key).toBe('value');
      expect(s.durationMs).toBeDefined();
      expect(s.durationMs!).toBeGreaterThanOrEqual(0);
    });

    it('should record exceptions', () => {
      const s = new Span('error-op', 'function');
      const err = new Error('test error');
      s.recordException(err);

      expect(s.attributes['error.type']).toBe('Error');
      expect(s.attributes['error.message']).toBe('test error');
    });
  });

  describe('withSpan', () => {
    it('should execute function and return result', async () => {
      const result = await withSpan('add', async () => 2 + 3);
      expect(result).toBe(5);
    });

    it('should propagate span context to nested spans', async () => {
      let outerTraceId: string | undefined;
      let innerTraceId: string | undefined;
      let innerParentSpanId: string | undefined;

      await withSpan('outer', async (outerSpan) => {
        outerTraceId = outerSpan.traceId;

        await withSpan('inner', async (innerSpan) => {
          innerTraceId = innerSpan.traceId;
          innerParentSpanId = innerSpan.parentSpanId;
        });
      });

      // Inner span should inherit trace ID from outer
      expect(innerTraceId).toBe(outerTraceId);
      // Inner span's parent should be the outer span
      expect(innerParentSpanId).toBeDefined();
    });

    it('should record exceptions and re-throw', async () => {
      let spanError: string | undefined;

      await expect(
        withSpan('failing', async (s) => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
    });

    it('should not have span context outside withSpan', () => {
      expect(getCurrentSpanInfo()).toBeUndefined();
    });

    it('should set span context during execution', async () => {
      let captured: any;
      await withSpan('check-ctx', async () => {
        captured = getCurrentSpanInfo();
      });

      expect(captured).toBeDefined();
      expect(captured.traceId).toBeDefined();
      expect(captured.spanId).toBeDefined();
    });
  });

  describe('spanContext', () => {
    it('should create a span for manual control', () => {
      const s = spanContext('manual-op', { componentType: 'workflow' });
      expect(s.name).toBe('manual-op');
      expect(s.componentType).toBe('workflow');
      s.setAttribute('step', '1');
      s.end();
      expect(s.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('span decorator', () => {
    it('should wrap async function in a span', async () => {
      const traced = span('my-func')(async (x: number) => x * 2);
      const result = await traced(5);
      expect(result).toBe(10);
    });

    it('should use function name as fallback', async () => {
      async function myNamedFunction() { return 42; }
      const traced = span()(myNamedFunction);
      const result = await traced();
      expect(result).toBe(42);
    });
  });
});
