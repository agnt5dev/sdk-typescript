import { ActivationError, ActivationErrorCode } from './errors.js';

/** Runtime-owned interruption must unwind without failing or compensating user work. */
export function isControlFlow(error: unknown): boolean {
  if (error instanceof ActivationError) {
    // These outcomes require waiting, fresh authority, cancellation, or runtime
    // resolution of an uncertain effect. Invalid definitions/payloads are failures.
    return ([ActivationErrorCode.Contended, ActivationErrorCode.StaleAuthority,
      ActivationErrorCode.Cancelled, ActivationErrorCode.UnknownOutcome,
      ActivationErrorCode.RequiredChildUnresolved] as string[]).includes(error.code);
  }
  return ['WaitingForUserInputError', 'DurableSleepSuspensionError', 'SuspensionRequestedError'].includes((error as Error)?.name);
}
