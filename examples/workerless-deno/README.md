# AGNT5 Workerless on Deno

This example serves the AGNT5 workerless protocol with Deno's fetch-native
HTTP server and `@agnt5/sdk/serverless`.

It exposes:

- `GET /.well-known/agnt5`
- `POST /agnt5/invoke`

## Local Run

This repo-local example maps `@agnt5/sdk/serverless` to the workspace
`../../dist/serverless.js` build in `deno.json`. `deno task dev` builds the
TypeScript SDK first. You can also rebuild it manually after editing SDK
sources:

```bash
(cd ../.. && npm run build:ts)
```

```bash
export AGNT5_SERVERLESS_SIGNING_SECRET="$(openssl rand -base64 32)"
deno task dev
```

Validate the endpoint:

```bash
curl http://127.0.0.1:8787/.well-known/agnt5
```

AGNT5 does not have a Deno-specific smoke command yet. Use the generic local
manifest check above, then sync the deployed HTTPS endpoint with AGNT5.

The published `@agnt5/sdk@0.5.7` package does not export
`@agnt5/sdk/serverless`. Keep the local import-map entry until the next SDK
publish includes the serverless export.

## Sync With AGNT5

Deploy this server to Deno Deploy or another Deno host with a stable HTTPS URL,
then sync it:

```bash
( umask 077 && openssl rand -base64 32 > .agnt5-serverless-secret )
# Store "$(cat .agnt5-serverless-secret)" in the Deno host's
# AGNT5_SERVERLESS_SIGNING_SECRET environment variable.
export AGNT5_SERVERLESS_SIGNING_SECRET="$(cat .agnt5-serverless-secret)"

agnt5 serverless sync \
  https://<deno-host> \
  --provider node \
  --env production \
  --immutable-ref <git-sha-or-deployment-id> \
  --signing-secret-env AGNT5_SERVERLESS_SIGNING_SECRET \
  --request-timeout-ms 30000 \
  --yield-before-timeout-ms 1000
```

Use `--provider node` until AGNT5 adds a dedicated `deno` provider label. The
runtime protocol is the same fetch-native serverless protocol used by
Cloudflare Workers and Vercel route handlers.
