import { readFileSync } from 'node:fs';

const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const releaseWorkflow = readFileSync(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8',
);
const packageUrl = new URL('../package.json', import.meta.url);
const packageManifest = JSON.parse(readFileSync(packageUrl, 'utf8'));

function requirePattern(source, pattern, message) {
  if (!pattern.test(source)) {
    throw new Error(message);
  }
}

function forbidPattern(source, pattern, message) {
  if (pattern.test(source)) {
    throw new Error(message);
  }
}

// Extract the top-level `on:` block so trigger checks do not match
// unrelated text (for example `if:` expressions or comments).
function triggerBlock(source) {
  const match = source.match(/^on:\n((?:[ \t]+.*\n?|\n)*)/m);
  if (!match) {
    throw new Error('Workflow must declare a top-level `on:` block');
  }
  return match[1];
}

// --- ci.yml: pull request validation, manually triggerable -----------------
requirePattern(ciWorkflow, /^  validate-pr:$/m, 'CI workflow must define dedicated PR validation');
requirePattern(triggerBlock(ciWorkflow), /^  pull_request:/m, 'CI workflow must run on pull requests');
requirePattern(
  triggerBlock(ciWorkflow),
  /^  workflow_dispatch:/m,
  'CI workflow must be manually triggerable',
);
forbidPattern(triggerBlock(ciWorkflow), /^  release:/m, 'CI workflow must not run on releases');

// --- release.yml: strictly on published GitHub releases --------------------
requirePattern(
  triggerBlock(releaseWorkflow),
  /^  release:\n    types: \[published\]/m,
  'Release workflow must run on published GitHub releases',
);
forbidPattern(
  triggerBlock(releaseWorkflow),
  /^  workflow_dispatch:/m,
  'Release workflow must not be manually triggerable',
);
forbidPattern(
  triggerBlock(releaseWorkflow),
  /^  (pull_request|push):/m,
  'Release workflow must not run on pull requests or pushes',
);
forbidPattern(
  releaseWorkflow,
  /^  validate-pr:$/m,
  'PR validation belongs in ci.yml, not the release workflow',
);
forbidPattern(
  releaseWorkflow,
  /skip-publish|--dry-run/,
  'Release workflow must always publish; dry runs belong in ci.yml',
);

// --- shared: persistent compiler caching -----------------------------------
for (const [label, workflow] of [
  ['CI', ciWorkflow],
  ['Release', releaseWorkflow],
]) {
  requirePattern(
    workflow,
    /mozilla-actions\/sccache-action@v0\.0\.11/,
    `${label} workflow must use the persistent sccache action`,
  );
  requirePattern(
    workflow,
    /RUSTC_WRAPPER: sccache/,
    `${label} workflow must route Rust compilation through sccache`,
  );
  for (const staleLocalCacheSetting of ['SCCACHE_DIR', 'SCCACHE_VERSION', 'sccache-target']) {
    if (workflow.includes(staleLocalCacheSetting)) {
      throw new Error(
        `${label} workflow still contains local-only cache setting ${staleLocalCacheSetting}`,
      );
    }
  }
}

requirePattern(
  releaseWorkflow,
  /SCCACHE_GHA_ENABLED: "true"/,
  'Release workflow must enable the GitHub Actions sccache backend',
);

// --- CI: compiler cache shared across branches via R2 ----------------------
// The Actions cache is branch-scoped, so every PR starts cold. CI reads the
// bucket from repo variables/secrets and falls back to the Actions cache when
// they are absent (fork PRs).
for (const [pattern, message] of [
  [/SCCACHE_BUCKET=\$R2_BUCKET/, 'CI must point sccache at the R2 bucket'],
  [
    /SCCACHE_ENDPOINT=https:\/\/\$\{R2_ACCOUNT_ID\}\.r2\.cloudflarestorage\.com/,
    'CI must use the R2 S3-compatible endpoint',
  ],
  [/SCCACHE_REGION=auto/, 'CI must use region "auto" for R2'],
  [/SCCACHE_S3_KEY_PREFIX=sdk-typescript\//, 'CI must namespace the cache per repository'],
  [/secrets\.R2_ACCESS_KEY_ID/, 'CI must read the R2 access key from secrets'],
  [/secrets\.R2_SECRET_ACCESS_KEY/, 'CI must read the R2 secret key from secrets'],
  [/SCCACHE_GHA_ENABLED=true/, 'CI must fall back to the Actions cache without R2'],
  [/CARGO_INCREMENTAL: "0"/, 'CI must disable incremental compilation for sccache'],
  [/CARGO_PROFILE_DEV_DEBUG: "0"/, 'CI must strip debug info from dev builds'],
]) {
  requirePattern(ciWorkflow, pattern, message);
}

// --- publish contract ------------------------------------------------------
const prepublishOnly = packageManifest.scripts?.prepublishOnly ?? '';
requirePattern(
  releaseWorkflow,
  /name: Publish platform packages/,
  'Release workflow must publish native platform packages explicitly',
);
if (!/\bnapi prepublish\b/.test(prepublishOnly)) {
  throw new Error('prepublishOnly must prepare the NAPI publish manifest');
}
for (const requiredFlag of ['--no-gh-release', '--skip-optional-publish']) {
  if (!prepublishOnly.includes(requiredFlag)) {
    throw new Error(
      `prepublishOnly must include ${requiredFlag} because the release workflow owns platform and tag publication`,
    );
  }
}

console.log(
  'CI workflow covers pull requests; release workflow runs only on published GitHub releases.',
);
