import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from '../event-emitter';

describe('EventEmitter ordering', () => {
  it('makes equal source timestamps strictly monotonic in emission order', async () => {
    const timestamps: number[] = [];
    const payloadTimestamps: number[] = [];
    const nativeWorker = {
      emitCheckpoint: async (
        _runId: string,
        _eventType: string,
        data: string,
        _sequence: number,
        _metadata: Record<string, string>,
        timestampNs: number,
      ) => {
        timestamps.push(timestampNs);
        payloadTimestamps.push(JSON.parse(data).timestamp_ns);
      },
    };
    const emitter = new EventEmitter('run-1');
    emitter.setWorker(nativeWorker);
    const event = (eventType: string) =>
      ({
        eventType,
        eventId: eventType,
        name: 'step',
        componentType: 'step',
        correlationId: eventType,
        parentCorrelationId: 'workflow',
        timestampNs: 100n,
        metadata: {},
      }) as any;

    await emitter.emit(event('workflow.step.started'));
    await emitter.emit(event('workflow.step.completed'));

    expect(timestamps).toEqual([100, 1_100]);
    expect(payloadTimestamps).toEqual([100, 1_100]);
  });

  it('does not let event metadata override execution authority', async () => {
    const metadata: Record<string, string>[] = [];
    const nativeWorker = {
      emitCheckpoint: async (
        _runId: string,
        _eventType: string,
        _data: string,
        _sequence: number,
        value: Record<string, string>,
      ) => metadata.push(value),
    };
    const emitter = new EventEmitter('run-1', {
      dispatch_mode: 'pull',
      worker_id: 'worker-1',
      worker_session_id: 'session-1',
      lease_id: 'lease-1',
      lease_attempt: '1',
    });
    emitter.setWorker(nativeWorker);

    await emitter.emit({
      eventType: 'function.started',
      eventId: 'event-1',
      name: 'function',
      componentType: 'function',
      correlationId: 'event-1',
      parentCorrelationId: 'run-1',
      timestampNs: 100n,
      metadata: {
        lease_id: 'forged-lease',
        worker_id: 'forged-worker',
        custom: 'preserved',
      },
    } as any);

    expect(metadata[0]).toMatchObject({
      lease_id: 'lease-1',
      worker_id: 'worker-1',
      custom: 'preserved',
    });
  });

  it('batches consecutive lifecycle events before correctness boundaries', async () => {
    const nativeWorker = {
      queueEvent: vi.fn(),
      emitCheckpoint: vi.fn(),
      emitCheckpointBatch: vi.fn(),
    };
    const emitter = new EventEmitter('run-1');
    emitter.setWorker(nativeWorker);
    const event = (eventType: string) =>
      ({
        eventType,
        eventId: eventType,
        name: 'workflow',
        componentType: 'workflow',
        correlationId: eventType,
        parentCorrelationId: 'run-1',
        timestampNs: 100n,
        metadata: {},
      }) as any;

    await emitter.emit(event('run.started'));
    await emitter.emit(event('workflow.step.completed'));
    await emitter.emit(event('run.completed'));

    expect(nativeWorker.queueEvent).not.toHaveBeenCalled();
    expect(nativeWorker.emitCheckpointBatch.mock.calls[0][0].map((item: any) => item.eventType))
      .toEqual(['run.started']);
    expect(nativeWorker.emitCheckpoint.mock.calls.map(call => call[1])).toEqual([
      'workflow.step.completed',
      'run.completed',
    ]);
  });

  it('persists lifecycle batches before streaming and acknowledges the next boundary', async () => {
    const nativeWorker = {
      queueEvent: vi.fn(),
      emitCheckpoint: vi.fn(),
      emitCheckpointBatch: vi.fn(),
    };
    const emitter = new EventEmitter('run-1');
    emitter.setWorker(nativeWorker);
    const event = (eventType: string) =>
      ({
        eventType,
        eventId: eventType,
        name: 'agent',
        componentType: 'agent',
        correlationId: eventType,
        parentCorrelationId: 'run-1',
        timestampNs: 100n,
        metadata: {},
      }) as any;

    await emitter.emit(event('run.started'));
    await emitter.emit(event('agent.started'));
    await emitter.emit(event('lm.message.delta'));
    await emitter.emit(event('agent.iteration.completed'));

    expect(nativeWorker.emitCheckpointBatch).toHaveBeenCalledTimes(1);
    expect(nativeWorker.emitCheckpointBatch.mock.calls[0][0].map((item: any) => item.eventType))
      .toEqual(['run.started', 'agent.started']);
    expect(nativeWorker.queueEvent.mock.calls.map(call => call[1]))
      .toEqual(['lm.message.delta']);
    expect(nativeWorker.emitCheckpoint.mock.calls.map(call => call[1]))
      .toEqual(['agent.iteration.completed']);
    expect(nativeWorker.emitCheckpointBatch.mock.invocationCallOrder[0])
      .toBeLessThan(nativeWorker.queueEvent.mock.invocationCallOrder[0]);
    expect(nativeWorker.queueEvent.mock.invocationCallOrder[0])
      .toBeLessThan(nativeWorker.emitCheckpoint.mock.invocationCallOrder[0]);
  });

  it('flushes a trailing lifecycle batch before worker completion', async () => {
    const nativeWorker = {
      queueEvent: vi.fn(),
      emitCheckpoint: vi.fn(),
      emitCheckpointBatch: vi.fn(),
    };
    const emitter = new EventEmitter('run-1');
    emitter.setWorker(nativeWorker);

    await emitter.emit({
      eventType: 'function.completed',
      eventId: 'function.completed',
      name: 'function',
      componentType: 'function',
      correlationId: 'function',
      parentCorrelationId: 'run-1',
      timestampNs: 100n,
      metadata: {},
    } as any);
    expect(nativeWorker.emitCheckpointBatch).not.toHaveBeenCalled();

    await emitter.flush();

    expect(nativeWorker.emitCheckpointBatch.mock.calls[0][0].map((item: any) => item.eventType))
      .toEqual(['function.completed']);
  });
});
