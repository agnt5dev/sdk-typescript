import { describe, expect, it } from 'vitest';
import { decodeUserResponse } from '../hitl-response.js';

describe('decodeUserResponse', () => {
  it('decodes a skip and a typed answer as before', () => {
    expect(decodeUserResponse('__skipped__')).toBeNull();
    expect(decodeUserResponse('__skip__')).toBeNull();
    expect(decodeUserResponse('__custom__:Rust')).toBe('Rust');
    expect(decodeUserResponse('approve')).toBe('approve');
  });

  it('turns typed entries in a multiselect answer into their text', () => {
    expect(decodeUserResponse('["ai","__custom__:Rust"]')).toBe('["ai","Rust"]');
    expect(decodeUserResponse('["__custom__:only typed text"]')).toBe('["only typed text"]');
    expect(decodeUserResponse('["web","__custom__:café, \\"quoted\\""]')).toBe('["web","café, \\"quoted\\""]');
  });

  it('returns arrays without a typed entry exactly as sent', () => {
    expect(decodeUserResponse('["ai","web"]')).toBe('["ai","web"]');
    expect(decodeUserResponse('["ai", "web"]')).toBe('["ai", "web"]');
    expect(decodeUserResponse('["ai","mentions __custom__: inside"]')).toBe('["ai","mentions __custom__: inside"]');
    expect(decodeUserResponse('[not json __custom__:x')).toBe('[not json __custom__:x');
  });
});
