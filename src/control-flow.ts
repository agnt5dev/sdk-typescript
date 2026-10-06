/** Control flow must unwind the workflow rather than become a retryable failure. */
export function isControlFlow(error: unknown): boolean {
  return ['ActivationError', 'WaitingForUserInputError', 'DurableSleepSuspensionError', 'SuspensionRequestedError'].includes((error as Error)?.name);
}
