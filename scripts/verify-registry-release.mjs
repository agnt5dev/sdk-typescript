import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// A successful npm publish can leave a version staged but unreadable. Gate
// consumers on public metadata AND the tarball, without registry credentials.
export async function waitForPackage(name, version, {
  fetcher = fetch, pause = delay, attempts = 120, interval = 10000,
} = {}) {
  let failure = 'not available';
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetcher(
        `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
        { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15000) },
      );
      if (!response.ok) throw new Error(`metadata HTTP ${response.status}`);
      const metadata = await response.json();
      if (metadata.name !== name || metadata.version !== version || !metadata.dist?.tarball) {
        throw new Error('registry metadata does not match the release');
      }
      const tarballUrl = new URL(metadata.dist.tarball);
      if (tarballUrl.protocol !== 'https:' || tarballUrl.hostname !== 'registry.npmjs.org') {
        throw new Error('unexpected registry tarball host');
      }
      const tarball = await fetcher(tarballUrl, {
        method: 'HEAD', signal: AbortSignal.timeout(15000),
      });
      if (!tarball.ok) throw new Error(`tarball HTTP ${tarball.status}`);
      return;
    } catch (error) {
      failure = error.message;
    }
    if (attempt + 1 < attempts) await pause(interval);
  }
  throw new Error(`${name}@${version} is not publicly available: ${failure}. Check npm scan/staged status before retrying publication.`);
}

export function platformManifests(root) {
  return readdirSync(new URL('npm/', root))
    .map(dir => new URL(`npm/${dir}/package.json`, root))
    .filter(file => existsSync(file))
    .map(file => JSON.parse(readFileSync(file, 'utf8')));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  const manifests = process.argv.includes('--main')
    ? [manifest]
    : platformManifests(root);
  if (manifests.length === 0) throw new Error('No package manifests found to verify');
  await Promise.all(manifests.map(async pkg => {
    await waitForPackage(pkg.name, manifest.version);
    console.log(`Publicly available: ${pkg.name}@${manifest.version}`);
  }));
}
