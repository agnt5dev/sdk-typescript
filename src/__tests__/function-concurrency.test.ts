import { AsyncLocalStorage } from 'node:async_hooks';
import { beforeEach, describe, expect, it } from 'vitest';
import { fn, FunctionRegistry } from '../function';

class ConcurrentTestContext {
  readonly invocationId = 'invocation-1';
  readonly runId = 'run-1';
  readonly attempt = 0;
  readonly serviceName = 'test';
  readonly runtime = {} as any;
  readonly signal = new AbortController().signal;
  readonly events: any[] = [];
  readonly scope = new AsyncLocalStorage<string>();
  private stepIndex = 0;

  async emit(event: any): Promise<void> {
    if (event.parentCorrelationId == null) {
      event.parentCorrelationId = this.scope.getStore() ?? 'workflow-cid';
    }
    this.events.push(event);
  }

  getCurrentCorrelationId(): string {
    return this.scope.getStore() ?? 'workflow-cid';
  }

  nextStepName(name: string): string {
    return `${name}_${this.stepIndex++}`;
  }

  runWithCorrelation<T>(cid: string, callback: () => T | Promise<T>): T | Promise<T> {
    return this.scope.run(cid, callback);
  }

  pushCorrelation(): never {
    throw new Error('task-local correlation should avoid the shared stack');
  }

  popCorrelation(): never {
    throw new Error('task-local correlation should avoid the shared stack');
  }
}

describe('nested function concurrency', () => {
  beforeEach(() => FunctionRegistry.clear());

  it('keeps parent correlations branch-local and emits the component name', async () => {
    const ctx = new ConcurrentTestContext();
    const analyze = fn('ks_analyze_text').run(
      async (handlerContext: any, input: { text: string; delayMs: number }) => {
        await new Promise((resolve) => setTimeout(resolve, input.delayMs));
        await handlerContext.emit({
          eventType: 'agent.started',
          correlationId: `agent-${input.text}`,
          parentCorrelationId: null,
        });
        return input.text.toUpperCase();
      },
    );

    await Promise.all([
      analyze(ctx as any, { text: 'one', delayMs: 20 }),
      analyze(ctx as any, { text: 'two', delayMs: 0 }),
      analyze(ctx as any, { text: 'three', delayMs: 10 }),
    ]);

    const functionStarts = ctx.events.filter((event) => event.eventType === 'function.started');
    expect(functionStarts).toHaveLength(3);
    expect(functionStarts.map((event) => event.name)).toEqual([
      'ks_analyze_text',
      'ks_analyze_text',
      'ks_analyze_text',
    ]);

    const functionCidByText = new Map(
      functionStarts.map((event) => [event.inputData.text, event.correlationId]),
    );
    for (const event of ctx.events.filter((candidate) => candidate.eventType === 'agent.started')) {
      const text = event.correlationId.slice('agent-'.length);
      expect(event.parentCorrelationId).toBe(functionCidByText.get(text));
    }
  });
});
