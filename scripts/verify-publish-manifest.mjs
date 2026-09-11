import { readFileSync } from 'node:fs';

const manifestUrl = new URL('../package.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
const expectedOptionalDependencies = {
  'better-sqlite3': '^11.0.0',
};
const platformDependencies = {
  '@agnt5/sdk-darwin-arm64': 'file:npm/darwin-arm64',
  '@agnt5/sdk-linux-arm64-gnu': 'file:npm/linux-arm64-gnu',
  '@agnt5/sdk-linux-x64-gnu': 'file:npm/linux-x64-gnu',
};

for (const [name, version] of Object.entries(expectedOptionalDependencies)) {
  const actual = manifest.optionalDependencies?.[name];
  if (actual !== version) {
    throw new Error(
      `Published package manifest must preserve optional dependency ${name}@${version}; found ${String(actual)}`,
    );
  }
}

for (const [name, localPath] of Object.entries(platformDependencies)) {
  const platform = JSON.parse(readFileSync(new URL(`../${localPath.slice(5)}/package.json`, import.meta.url), 'utf8'));
  if (platform.name !== name || platform.version !== manifest.version) {
    throw new Error(`Native package ${name} must match SDK version ${manifest.version}; found ${platform.version}`);
  }
}

const platformVersions = Object.entries(platformDependencies).map(([name, localPath]) => ({
  name,
  localPath,
  actual: manifest.optionalDependencies?.[name],
}));
const usesLocalPackages = platformVersions.every(({ actual, localPath }) => actual === localPath);
const usesPublishedVersions = platformVersions.every(({ actual }) => actual === manifest.version);

if (!usesLocalPackages && !usesPublishedVersions) {
  throw new Error(
    `Native optional dependencies must all use their local release packages or version ${manifest.version}: ${platformVersions
      .map(({ name, actual }) => `${name}@${String(actual)}`)
      .join(', ')}`,
  );
}

console.log(
  `Publish manifest preserves non-platform optional dependencies and uses ${
    usesLocalPackages ? 'local native release packages' : 'versioned native release packages'
  }.`,
);
