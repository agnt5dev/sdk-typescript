import { describe, expect, it } from 'vitest';

import { isCheckpointEvent, isSseOnlyEvent } from '../events.js';

describe('event durability classification', () => {
  it.each([
    'lm.content_block.started',
    'lm.content_block.delta',
    'lm.content_block.completed',
  ])('classifies %s as transient', (eventType) => {
    expect(isSseOnlyEvent(eventType)).toBe(true);
    expect(isCheckpointEvent(eventType)).toBe(false);
  });
});
