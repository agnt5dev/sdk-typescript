/**
 * EventEmitter routes events to the platform via NAPI Worker methods.
 *
 * Mirrors Python SDK's EventEmitter (events.py):
 * - Checkpoint events → nativeWorker.emitCheckpoint() → EE gRPC WriteCheckpoint
 * - SSE-only events → nativeWorker.queueEvent() → JournalEventQueue → flush task
 */

import type { BaseEvent } from './events.js';
import { isCheckpointEvent, toEventPayload } from './events.js';

export class EventEmitter {
  private runId: string;
  private baseMetadata: Record<string, string>;
  private sequence = 0;
  private nativeWorker: any = null;

  constructor(runId: string, baseMetadata: Record<string, string> = {}) {
    this.runId = runId;
    this.baseMetadata = baseMetadata;
  }

  /**
   * Set the NAPI Worker reference for event emission.
   * Must be called before emit() — events are silently dropped without a worker.
   */
  setWorker(nativeWorker: any): void {
    this.nativeWorker = nativeWorker;
  }

  /**
   * Emit an event to the platform.
   *
   * Checkpoint events (lifecycle) are sent synchronously via gRPC WriteCheckpoint.
   * SSE-only events (streaming) are queued for async batch flush.
   */
  async emit(event: BaseEvent): Promise<void> {
    if (!this.nativeWorker) {
      return; // No worker — running locally or in tests
    }

    this.sequence++;

    const eventData = JSON.stringify(toEventPayload(event));
    const metadata: Record<string, string> = { ...this.baseMetadata };

    // Copy string metadata from event (skip non-string values)
    for (const [k, v] of Object.entries(event.metadata || {})) {
      if (typeof v === 'string') {
        metadata[k] = v;
      }
    }

    const timestampNs = Number(event.timestampNs);

    if (isCheckpointEvent(event.eventType)) {
      // Add correlation IDs to metadata (matches Python EventEmitter convention)
      metadata['cid'] = event.correlationId;
      metadata['pcid'] = event.parentCorrelationId || '';

      await this.nativeWorker.emitCheckpoint(
        this.runId,
        event.eventType,
        eventData,
        this.sequence,
        metadata,
        timestampNs,
        5000, // timeout_ms
      );
    } else {
      // SSE-only — push to journal queue (non-blocking)
      this.nativeWorker.queueEvent(
        this.runId,
        event.eventType,
        eventData,
        0, // contentIndex
        this.sequence,
        metadata,
        timestampNs,
        event.correlationId,
        event.parentCorrelationId || '',
      );
    }
  }
}
