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
});
