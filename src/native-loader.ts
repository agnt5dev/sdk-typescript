/** Return bindings already loaded by the worker without triggering native I/O. */
export function getLoadedNativeBindings(): any | null {
  return null;
}

export function tryLoadNativeBindings(): any | null {
  return null;
}

export function loadNativeBindings(): any {
  throw new Error('Native bindings are unavailable in this JavaScript runtime');
}
