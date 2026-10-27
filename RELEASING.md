# Releasing the TypeScript SDK

GitHub builds and stages release packages using npm trusted publishing (OIDC).
A maintainer reviews and approves the staged packages with 2FA before they become
public. The workflow does not use a stored npm publishing token.

## Configure npm once

Enable 2FA on the maintainer account. In each package's Settings → Trusted
publishing, add the same GitHub Actions configuration:

| Field | Value |
| --- | --- |
| Organization or user | `agnt5dev` |
| Repository | `sdk-typescript` |
| Workflow filename | `release.yml` |
| Environment | Leave empty |
| Allowed action | `npm stage publish` only |

Configure all four packages:

- `@agnt5/sdk`
- `@agnt5/sdk-darwin-arm64`
- `@agnt5/sdk-linux-arm64-gnu`
- `@agnt5/sdk-linux-x64-gnu`

A new connection stays pending until its first successful publication, which
must complete within npm's two-day validation window. Follow the deadline shown
on each package. If a connection expires, delete it and create a new one.

The staging job uses a GitHub-hosted runner, Node 24, npm 11.21.0, and job-scoped
`id-token: write`. npm verifies the repository and workflow identity and supplies
short-lived credentials. The package repository URL must continue to identify
this repository.

## Stage a release

1. Merge a change whose root package, native crate, platform manifests, lockfiles,
   and changelog all name the same version.
2. Publish a GitHub release with the matching `vX.Y.Z` tag. This starts
   `release.yml`; it cannot be triggered manually or from a pull request.
3. Wait for the native builds, glibc 2.31 load checks, package checks, and staging
   job. Each package is staged with provenance and its intended dist-tag.
4. Read the staging output and the `npm-staging-receipts-*` workflow artifact.
   A successful workflow means packages are staged, not publicly installable.

The failed `v0.10.16` release uses the old workflow. Retrying it will not pick up
the migration. Release `v0.10.17` from the merged workflow instead.

## Review and approve

Use npmjs.com → the package → Staged Packages, or a local npm CLI version 11.15.0
or newer with Node 22.14.0 or newer. Review the version, source provenance, and
package contents. Stage review and approval use your interactive npm login;
the workflow's OIDC identity cannot approve packages.

1. Approve the three native packages with 2FA.
2. From a checkout of the same release tag, verify that their metadata and
   tarballs are publicly available:

   ```bash
   node scripts/verify-registry-release.mjs
   ```

3. After that check passes, approve `@agnt5/sdk` with 2FA. Approving the main SDK
   first can expose a version whose optional native dependencies are unavailable.
4. Verify the main package and its dist-tag:

   ```bash
   node scripts/verify-registry-release.mjs --main
   npm view @agnt5/sdk dist-tags --json
   ```

The CLI equivalents for reviewing and approving a stage are:

```bash
npm stage list @agnt5/sdk
npm stage view <stage-id>
npm stage download <stage-id>
npm stage approve <stage-id>
```

Approval prompts for 2FA. When all four packages are public, perform a clean
installation and native-binding load check before announcing the release.

## Harden access and handle retries

After the first successful OIDC release validates every connection, set each
package's Publishing access to **Require two-factor authentication and disallow
tokens**. Revoke unused publishing tokens and remove the obsolete `NPM_TOKEN`
GitHub secret. Keep direct publishing and dist-tag permissions disabled on the
trusted publisher unless a future release process explicitly needs them.

A staged version reserves its version number. If a retry reports that the
version already exists but `npm view` cannot find it, review the existing stage.
Approve the stages already created, then rerun failed jobs to continue with the
remaining packages. Do not automatically reject or recreate staged versions.

See npm's [trusted publishing guide](https://docs.npmjs.com/trusted-publishers/)
and [staged publishing guide](https://docs.npmjs.com/staged-publishing/) for setup
and approval details.
