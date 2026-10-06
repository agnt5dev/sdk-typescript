/** Bounded error details shared by run events and native completion responses. */
export function errorDetails(error: unknown): { errorMessage: string; errorType: string; errorStack?: string } {
  const value = error instanceof Error ? error : new Error(String(error));
  return {
    errorMessage: value.message,
    errorType: error instanceof Error ? error.name || error.constructor.name : typeof error,
    ...(value.stack ? { errorStack: value.stack.slice(0, 16_384) } : {}),
  };
}
