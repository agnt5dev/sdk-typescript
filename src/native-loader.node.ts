import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: any = null;
let loadAttempted = false;

/** Return bindings already loaded by the worker without triggering native I/O. */
export function getLoadedNativeBindings(): any | null {
  return cached;
}

export function tryLoadNativeBindings(): any | null {
  if (cached) return cached;
  if (loadAttempted) return null;
  try {
    return loadNativeBindings();
  } catch {
    return null;
  }
}

export function loadNativeBindings(): any {
  if (cached) return cached;
  loadAttempted = true;

  const moduleUrl = import.meta.url;
  const nodeProcess = (globalThis as any).process as NodeJS.Process | undefined;
  if (!moduleUrl || !nodeProcess?.versions?.node) {
    throw new Error('Native bindings are unavailable in this JavaScript runtime');
  }

  const require = createRequire(moduleUrl);
  const { platform, arch } = nodeProcess;

  let pkgName: string | null = null;
  switch (platform) {
    case 'darwin':
      if (arch === 'arm64') pkgName = '@agnt5/sdk-darwin-arm64';
      else if (arch === 'x64') pkgName = '@agnt5/sdk-darwin-x64';
      break;
    case 'linux':
      if (arch === 'arm64') pkgName = '@agnt5/sdk-linux-arm64-gnu';
      else if (arch === 'x64') pkgName = '@agnt5/sdk-linux-x64-gnu';
      break;
  }
  if (!pkgName) {
    throw new Error(`Unsupported platform ${platform}-${arch}`);
  }

  const __dirname = dirname(fileURLToPath(moduleUrl));
  for (const suffix of [`${platform}-${arch}`, `${platform}-${arch}-gnu`]) {
    // Published/file dependencies include native/*.node, while a source-tree
    // build also places the binary at the package root.
    for (const rel of ['../', '../native/', '../../']) {
      try {
        cached = require(join(__dirname, rel, `agnt5-sdk-native.${suffix}.node`));
        return cached;
      } catch {}
    }
  }

  try {
    cached = require(pkgName);
    return cached;
  } catch (primaryError) {
    throw new Error(
      `Failed to load native bindings: ${pkgName} not installed, no local build found. ` +
      `Run "pnpm run build:napi" from the repository root. Original: ${(primaryError as Error).message}`
    );
  }
}
