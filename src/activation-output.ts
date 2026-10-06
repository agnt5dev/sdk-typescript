import { ActivationError, ActivationErrorCode } from './errors.js';

type ActivationOutput<T> = { version: 1; kind: 'undefined' } | { version: 1; kind: 'value'; value: T };

/** Wrap every output so an undefined sentinel cannot collide with user data. */
export function encodeActivationOutput<T>(value: T): Uint8Array {
  const output: ActivationOutput<T> = value === undefined
    ? { version: 1, kind: 'undefined' }
    : { version: 1, kind: 'value', value };
  return new TextEncoder().encode(JSON.stringify(output));
}

export function decodeActivationOutput<T>(bytes: Uint8Array): T {
  const output = JSON.parse(new TextDecoder().decode(bytes)) as ActivationOutput<T>;
  if (output?.version === 1 && output.kind === 'undefined') return undefined as T;
  if (output?.version === 1 && output.kind === 'value' && Object.prototype.hasOwnProperty.call(output, 'value')) return output.value;
  throw new ActivationError(ActivationErrorCode.NonDeterministicReplay, 'activation output is missing its value envelope');
}
