import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyTrustedStaging } from './trusted-publishing-contract.mjs';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('accepts the stage-only OIDC release workflow', () => {
  assert.doesNotThrow(() => verifyTrustedStaging(workflow));
});

test('requires OIDC permission on the staging job', () => {
  assert.throws(() => verifyTrustedStaging(workflow.replace('      id-token: write\n', '')), /OIDC/);
  assert.throws(() => verifyTrustedStaging(workflow.replace('permissions:\n  contents: read', 'permissions:\n  contents: read\n  id-token: write')), /scoped to the staging job/);
});

test('rejects a stored publishing credential even alongside OIDC', () => {
  assert.throws(() => verifyTrustedStaging(workflow + '\n# end\nenv:\n  NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n'), /stored npm credentials/);
});

test('rejects direct publishing for either package phase', () => {
  assert.throws(() => verifyTrustedStaging(workflow.replace('npm stage publish', 'npm publish')), /publishing directly/);
});

test('rejects automated approval even after successful staging', () => {
  assert.throws(() => verifyTrustedStaging(workflow + '\n      - run: npm stage approve example\n'), /interactive maintainer/);
});

test('requires a hosted runner and the stage-capable runtime', () => {
  assert.throws(() => verifyTrustedStaging(workflow.replace('    runs-on: ubuntu-latest\n    permissions:', '    runs-on: self-hosted\n    permissions:')), /GitHub-hosted/);
  assert.throws(() => verifyTrustedStaging(workflow.replace("node-version: '24'", "node-version: '20'")), /Node 24/);
  assert.throws(() => verifyTrustedStaging(workflow.replace('npm@11.21.0', 'npm@10')), /stage-capable npm/);
});

test('requires publish manifest preparation before packing staged packages', () => {
  assert.throws(() => verifyTrustedStaging(workflow.replaceAll('npx napi prepublish', 'echo manifest omitted')), /versioned native dependencies/);
  const latePreparation = workflow.replaceAll('npx napi prepublish', 'echo manifest omitted')
    + '\n      - run: npx napi prepublish -t npm --no-gh-release --skip-optional-publish\n';
  assert.throws(() => verifyTrustedStaging(latePreparation), /before packing/);
});
