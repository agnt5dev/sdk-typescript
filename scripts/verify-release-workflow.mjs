import { readFileSync } from 'node:fs';

const workflowUrl = new URL('../.github/workflows/release.yml', import.meta.url);
const workflow = readFileSync(workflowUrl, 'utf8');

function requirePattern(pattern, message) {
  if (!pattern.test(workflow)) {
    throw new Error(message);
  }
}

requirePattern(/^  validate-pr:$/m, 'Release workflow must define dedicated PR validation');
requirePattern(
  /if: github\.event_name == 'pull_request'/,
  'PR validation must run only for pull requests',
);
requirePattern(
  /if: github\.event_name != 'pull_request'/,
  'Release validation must keep the native matrix off pull requests',
);
requirePattern(
  /mozilla-actions\/sccache-action@v0\.0\.11/,
  'Native builds must use the persistent sccache action',
);
requirePattern(
  /SCCACHE_GHA_ENABLED: "true"/,
  'Native builds must enable the GitHub Actions sccache backend',
);
requirePattern(/RUSTC_WRAPPER: sccache/, 'Rust jobs must route compilation through sccache');

for (const staleLocalCacheSetting of ['SCCACHE_DIR', 'SCCACHE_VERSION', 'sccache-target']) {
  if (workflow.includes(staleLocalCacheSetting)) {
    throw new Error(`Release workflow still contains local-only cache setting ${staleLocalCacheSetting}`);
  }
}

console.log('Release workflow keeps PR validation lean and compiler caching persistent.');
