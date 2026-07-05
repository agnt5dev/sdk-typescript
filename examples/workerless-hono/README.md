# AGNT5 Workerless on Hono

This example mounts the fetch-native `@agnt5/sdk/serverless` handler on a Hono
app. The same app can run on Hono's Node server, Cloudflare Workers, Deno, Bun,
or another Hono adapter that preserves the original `Request`.

It exposes:

- `GET /.well-known/agnt5`
- `POST /agnt5/invoke`

## Local Run

```bash
npm install
npm run build
export AGNT5_SERVERLESS_SIGNING_SECRET="$(openssl rand -base64 32)"
npm start
```

Validate the endpoint:

```bash
curl http://127.0.0.1:8787/.well-known/agnt5
```

Use a framework-specific deploy command for the Hono adapter you choose, then
sync the deployed HTTPS endpoint with AGNT5.

## Sync With AGNT5

```bash
( umask 077 && openssl rand -base64 32 > .agnt5-serverless-secret )
# Store "$(cat .agnt5-serverless-secret)" in the host's
# AGNT5_SERVERLESS_SIGNING_SECRET environment variable.
export AGNT5_SERVERLESS_SIGNING_SECRET="$(cat .agnt5-serverless-secret)"

agnt5 serverless sync \
  https://<hono-host> \
  --provider node \
  --env production \
  --immutable-ref <git-sha-or-deployment-id> \
  --signing-secret-env AGNT5_SERVERLESS_SIGNING_SECRET \
  --request-timeout-ms 30000 \
  --yield-before-timeout-ms 1000
```

Use `--provider node` for Hono's Node server. Use `--provider cloudflare` or
`--provider vercel` only when the Hono app is deployed through that provider and
you want AGNT5 to apply provider-specific immutable-ref defaults.
