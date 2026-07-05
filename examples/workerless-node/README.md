# AGNT5 Workerless on Generic Node.js

This example serves the AGNT5 workerless protocol with Node's built-in
`node:http` module and `@agnt5/sdk/serverless/node`.

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

From the AGNT5 repository root, run the generic Node smoke:

```bash
just test-e2e-workerless-node-smoke http://127.0.0.1:8787
```

## Sync With AGNT5

Deploy this server to a Node host with a stable HTTPS URL, then sync it:

```bash
( umask 077 && openssl rand -base64 32 > .agnt5-serverless-secret )
# Store "$(cat .agnt5-serverless-secret)" in the Node host's
# AGNT5_SERVERLESS_SIGNING_SECRET environment variable.
export AGNT5_SERVERLESS_SIGNING_SECRET="$(cat .agnt5-serverless-secret)"

agnt5 serverless sync \
  https://<node-host> \
  --provider node \
  --env production \
  --immutable-ref <git-sha-or-release-id> \
  --signing-secret-env AGNT5_SERVERLESS_SIGNING_SECRET \
  --request-timeout-ms 30000 \
  --yield-before-timeout-ms 1000
```

Validate a deployed endpoint:

```bash
export AGNT5_SERVERLESS_SIGNING_SECRET="$(cat .agnt5-serverless-secret)"
just test-e2e-workerless-node-smoke https://<node-host>
```

## Framework Mounting

Express, Fastify, and Koa should delegate the AGNT5 protocol routes to the same
`serveNode()` handler. Keep the original request body available for
`/agnt5/invoke`; signed invoke verification uses the raw bytes.

Express:

```ts
app.all('/.well-known/agnt5', (request, response) => {
  void agnt5Workerless(request, response);
});
app.all('/agnt5/invoke', (request, response) => {
  void agnt5Workerless(request, response);
});
```

Fastify:

```ts
fastify.all('/.well-known/agnt5', (request, reply) =>
  agnt5Workerless(request.raw, reply.raw)
);
fastify.all('/agnt5/invoke', (request, reply) =>
  agnt5Workerless(request.raw, reply.raw)
);
```

Koa:

```ts
router.all('/.well-known/agnt5', async (ctx) => {
  ctx.respond = false;
  await agnt5Workerless(ctx.req, ctx.res);
});
router.all('/agnt5/invoke', async (ctx) => {
  ctx.respond = false;
  await agnt5Workerless(ctx.req, ctx.res);
});
```
