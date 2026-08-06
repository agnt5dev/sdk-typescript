/**
 * EventEmitter routes events to the platform via NAPI Worker methods.
 *
 * Mirrors Python SDK's EventEmitter (events.py):
 * - Terminal/correctness checkpoints → nativeWorker.emitCheckpoint() → acknowledged append
 * - Non-terminal lifecycle and SSE-only events → JournalEventQueue → flush task
 */

import type { BaseEvent } from './events.js';
import { isCheckpointEvent } from './events.js';

const EXECUTION_AUTHORITY_METADATA_KEYS = [
  'dispatch_mode',
  'worker_id',
  'worker_session_id',
  'lease_id',
  'lease_attempt',
] as const;

const TERMINAL_EVENT_TYPES = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'workflow.completed',
  'workflow.failed',
  'workflow.paused',
]);

const IMMEDIATE_ACK_PREFIXES = [
  'workflow.step.',
  'workflow.state.',
  'approval.',
  'activation.',
];

function requiresImmediateAcknowledgement(eventType: string): boolean {
  return (
    TERMINAL_EVENT_TYPES.has(eventType) ||
    IMMEDIATE_ACK_PREFIXES.some(prefix => eventType.startsWith(prefix))
  );
}

/**
 * Convert camelCase key to snake_case.
 */
function toSnakeCase(key: string): string {
  return key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

/**
 * Serialize a BaseEvent to a full JSON string matching Python SDK's event.to_dict().
 *
 * Python sends ALL fields (event_type, correlation_id, name, etc.) in the event data.
 * The EE/Studio UI needs these fields (especially correlation_id) to link events
 * to the correct run lifecycle. Keys are converted from camelCase to snake_case.
 */
function serializeEvent(event: BaseEvent): string {
  const payload: Record<string, any> = {};

  for (const [key, value] of Object.entries(event)) {
    // Convert BigInt to Number for JSON serialization
    const serializedValue = typeof value === 'bigint' ? Number(value) : value;
    payload[toSnakeCase(key)] = serializedValue;
  }

  return JSON.stringify(payload);
}

export class EventEmitter {
  private runId: string;
  private baseMetadata: Record<string, string>;
  private sequence = 0;
  private lastTimestampNs = 0n;
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
   * Terminal and replay-sensitive checkpoints await persistence. Ordinary
   * non-terminal lifecycle events and SSE-only events use the batch queue.
   */
  async emit(event: BaseEvent): Promise<void> {
    if (!this.nativeWorker) {
      return; // No worker — running locally or in tests
    }

    this.sequence++;
    if (event.timestampNs <= this.lastTimestampNs) {
      // Native transport accepts a JavaScript Number, whose precision at
      // epoch-nanosecond scale is coarser than 1ns. Advance by 1µs so
      // concurrent events remain strictly ordered after Number conversion.
      event.timestampNs = this.lastTimestampNs + 1_000n;
    }
    this.lastTimestampNs = event.timestampNs;

    // Serialize full event with snake_case keys (matches Python SDK's event.to_dict())
    const eventData = serializeEvent(event);
    const metadata: Record<string, string> = { ...this.baseMetadata };

    // Copy string metadata from event (skip non-string values)
    for (const [k, v] of Object.entries(event.metadata || {})) {
      if (typeof v === 'string') {
        metadata[k] = v;
      }
    }
    for (const key of EXECUTION_AUTHORITY_METADATA_KEYS) {
      const value = this.baseMetadata[key];
      if (value !== undefined) metadata[key] = value;
    }

    const timestampNs = Number(event.timestampNs);

    if (
      isCheckpointEvent(event.eventType) &&
      (requiresImmediateAcknowledgement(event.eventType) ||
        typeof this.nativeWorker.queueEvent !== 'function')
    ) {
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
      // Queue ordinary lifecycle and SSE-only events. An acknowledged terminal
      // checkpoint drains this run first, preserving per-run order.
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
