/**
 * Integration test: Streaming events
 *
 * Tests SSE event streaming against a running platform.
 *
 * Requires a running AGNT5 platform.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createTestClient, skipIfNoPlatform } from './helpers.js';

describe.skip('Integration: Streaming', () => {
  beforeAll(async () => {
    await skipIfNoPlatform();
  });

  it('should stream text chunks', async () => {
    const client = createTestClient();
    const chunks: string[] = [];

    for await (const chunk of client.stream('echo', { text: 'hello world' })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join('')).toContain('hello world');
  });

  it('should stream typed events', async () => {
    const client = createTestClient();
    const events: string[] = [];

    for await (const event of client.events('greet', { name: 'Alice' })) {
      events.push(event.eventType);
    }

    expect(events).toContain('run.completed');
  });
});
