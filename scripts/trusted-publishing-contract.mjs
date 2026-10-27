function requireMatch(source, pattern, message) {
  if (!pattern.test(source)) throw new Error(message);
}

export function verifyTrustedStaging(workflow) {
  workflow = workflow.replace(/^\s*#.*$/gm, '');
  const stage = workflow.match(/^  stage:\n(?: {4}.*\n?|\n)*/m)?.[0];
  if (!stage) throw new Error('Release workflow must define an isolated staging job');
  requireMatch(stage, /^    runs-on: ubuntu-latest$/m, 'Staging requires a GitHub-hosted runner');
  requireMatch(stage, /^    permissions:\n      contents: read\n      id-token: write$/m,
    'Staging must have read-only contents access and OIDC token permission');
  if (/id-token:\s*write/.test(workflow.replace(stage, ''))) {
    throw new Error('OIDC permission must be scoped to the staging job');
  }
  requireMatch(stage, /node-version: ['"]?24['"]?\s*\n/, 'Staging must use Node 24');
  requireMatch(stage, /npm install --global npm@11\.21\.0\b/, 'Staging must install the pinned stage-capable npm CLI');
  requireMatch(stage, /npx napi prepublish -t npm --no-gh-release --skip-optional-publish/,
    'Staging must prepare versioned native dependencies before packing');
  if (stage.indexOf('npx napi prepublish') > stage.indexOf('npm stage publish')) {
    throw new Error('Staging must prepare versioned native dependencies before packing');
  }
  if (/NPM_TOKEN|NODE_AUTH_TOKEN|NPM_ID_TOKEN/.test(workflow)) {
    throw new Error('Release workflow must use OIDC without stored npm credentials');
  }
  if (/\bnpm\s+(?:--\S+\s+)*publish\b/.test(workflow)) {
    throw new Error('Release workflow must stage packages instead of publishing directly');
  }
  if (/\bnpm stage (?:approve|reject|list|view|download)\b/.test(stage)) {
    throw new Error('Stage review and approval require interactive maintainer authentication');
  }
  if ((stage.match(/\bnpm stage publish\b/g) || []).length !== 2) {
    throw new Error('Release workflow must stage native packages and the main SDK separately');
  }
}
