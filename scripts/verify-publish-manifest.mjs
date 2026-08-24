import { readFileSync } from 'node:fs';

const manifestUrl = new URL('../package.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
const expectedOptionalDependencies = {
  'better-sqlite3': '^11.0.0',
};

for (const [name, version] of Object.entries(expectedOptionalDependencies)) {
  const actual = manifest.optionalDependencies?.[name];
  if (actual !== version) {
    throw new Error(
      `Published package manifest must preserve optional dependency ${name}@${version}; found ${String(actual)}`,
    );
  }
}

console.log('Publish manifest preserves non-platform optional dependencies.');
