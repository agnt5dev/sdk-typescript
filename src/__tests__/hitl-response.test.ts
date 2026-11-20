import { describe, expect, it } from 'vitest';
import { decodeUserResponse } from '../hitl-response.js';

describe('decodeUserResponse', () => {
  it('decodes a skip and a typed answer as before', () => {
    expect(decodeUserResponse('__skipped__')).toBeNull();
    expect(decodeUserResponse('__skip__')).toBeNull();
    expect(decodeUserResponse('__custom__:Rust')).toBe('Rust');
    expect(decodeUserResponse('approve')).toBe('approve');
  });

  it.each(['multiselect', 'pick_many'])('turns typed entries in a %s answer into their text', (inputType) => {
    expect(decodeUserResponse('["ai","__custom__:Rust"]', inputType)).toBe('["ai","Rust"]');
    expect(decodeUserResponse('["__custom__:only typed text"]', inputType)).toBe('["only typed text"]');
    expect(decodeUserResponse('["web","__custom__:café, \\"quoted\\""]', inputType)).toBe('["web","café, \\"quoted\\""]');
  });

  it.each([undefined, 'text', 'freeform', 'approval', 'select', 'selection', 'unknown'])(
    'preserves literal arrays for question type %s',
    (inputType) => {
      const response = '["ai", "__custom__:Rust"]';
      expect(decodeUserResponse(response, inputType)).toBe(response);
    },
  );

  it('does not decode inside a standalone custom answer', () => {
    const response = '["__custom__:Rust"]';
    expect(decodeUserResponse(`__custom__:${response}`, 'multiselect')).toBe(response);
  });

  it('returns multiselect arrays without a typed entry exactly as sent', () => {
    expect(decodeUserResponse('["ai","web"]', 'multiselect')).toBe('["ai","web"]');
    expect(decodeUserResponse('["ai", "web"]', 'multiselect')).toBe('["ai", "web"]');
    expect(decodeUserResponse('["ai","mentions __custom__: inside"]', 'multiselect')).toBe('["ai","mentions __custom__: inside"]');
    expect(decodeUserResponse('[not json __custom__:x', 'multiselect')).toBe('[not json __custom__:x');
  });
});
