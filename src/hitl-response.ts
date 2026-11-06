const CUSTOM_PREFIX = '__custom__:';

/**
 * Decode the format a paused workflow is answered in, as sdk-python's
 * wait_for_user does.
 *
 * `"__skipped__"` (or `"__skip__"`) means the person skipped it: `null`. A typed
 * answer, `"__custom__:<text>"`, becomes its text. A multiselect answer is a
 * JSON-array string; text typed beside the ticked options is an entry of its
 * own, `"__custom__:<text>"`, and becomes that text, so
 * `'["ai","__custom__:Rust"]'` returns `'["ai","Rust"]'`. Anything else,
 * including an array with no such entry, returns unchanged.
 */
export function decodeUserResponse(userResponse: string): string | null {
  if (userResponse === '__skipped__' || userResponse === '__skip__') {
    return null;
  }
  if (userResponse.startsWith(CUSTOM_PREFIX)) {
    return userResponse.slice(CUSTOM_PREFIX.length);
  }
  if (userResponse.startsWith('[') && userResponse.includes(CUSTOM_PREFIX)) {
    let entries: unknown;
    try {
      entries = JSON.parse(userResponse);
    } catch {
      return userResponse;
    }
    const isTyped = (entry: unknown): entry is string =>
      typeof entry === 'string' && entry.startsWith(CUSTOM_PREFIX);
    if (Array.isArray(entries) && entries.some(isTyped)) {
      return JSON.stringify(
        entries.map((entry) => (isTyped(entry) ? entry.slice(CUSTOM_PREFIX.length) : entry)),
      );
    }
  }
  return userResponse;
}
