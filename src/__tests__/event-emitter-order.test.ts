import { describe, expect, it } from 'vitest';
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
});
