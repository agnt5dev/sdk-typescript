/**
 * A step's or other activation's input (a retrying function's arguments, a
 * tool call's arguments) with `undefined` object properties dropped, as JSON
 * would carry it, so an optional field left unset doesn't fail the canonical
 * encoding. Plain objects, arrays and bytes are copied, which makes the result
 * a snapshot: the activation hashes it and its body receives it, so the body
 * runs on exactly the value that was checked. Values the canonical encoding already accepts keep their
 * digests. `UInt64` and `Float64` are frozen, so they're shared rather than
 * copied. Anything else (a `Date`, a `Map`, a class instance, an `undefined`
 * array item) is passed through for the encoding to reject by type.
 */
export function normalizeStepInput(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  // Copied too (a Buffer stays a Buffer): bytes are the one mutable value the
  // encoding accepts besides plain objects and arrays.
  if (value instanceof Uint8Array) return Uint8Array.prototype.slice.call(value);
  if (Array.isArray(value)) return Array.from(value, item => normalizeStepInput(item));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    // Defined rather than assigned, so a parsed `__proto__` key stays a key.
    Object.defineProperty(normalized, key, {
      value: normalizeStepInput(item),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return normalized;
}
