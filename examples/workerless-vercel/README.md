# AGNT5 Workerless on Vercel or Next.js

This example mounts the fetch-native `@agnt5/sdk/serverless` handler on
Next.js route handlers. It exposes the two AGNT5 workerless protocol paths:

- `GET /.well-known/agnt5`
- `POST /agnt5/invoke`

Generate one signing secret locally, keep the file private, and store the same
value in the Vercel project environment before syncing or registering the
deployment with AGNT5.

The invoke route exports `maxDuration = 25`. Keep AGNT5
`request_timeout_ms` below that platform cap and set `yield_before_timeout_ms`
so workflows can suspend and checkpoint before Vercel terminates the request.

```bash
( umask 077 && openssl rand -base64 32 > .agnt5-serverless-secret )
vercel env add AGNT5_SERVERLESS_SIGNING_SECRET production < .agnt5-serverless-secret
vercel deploy --prod
export AGNT5_SERVERLESS_SIGNING_SECRET="$(cat .agnt5-serverless-secret)"

agnt5 serverless sync \
  https://<deployment-host> \
  --provider vercel \
  --env production \
  --signing-secret-env AGNT5_SERVERLESS_SIGNING_SECRET \
  --invoke-header-env x-vercel-protection-bypass=VERCEL_AUTOMATION_BYPASS_SECRET \
  --request-timeout-ms 10000 \
  --yield-before-timeout-ms 1000
```

When sync runs inside a Vercel build or automation environment with system
environment variables enabled, `--provider vercel` defaults the immutable ref
from `VERCEL_DEPLOYMENT_ID` and records commit metadata from
`VERCEL_GIT_COMMIT_SHA` and `VERCEL_GIT_COMMIT_MESSAGE`. Outside Vercel, pass
the deployment ID explicitly with `--immutable-ref`.

Validate the deployed endpoint directly from the AGNT5 repository root:

```bash
export AGNT5_SERVERLESS_SIGNING_SECRET="$(cat .agnt5-serverless-secret)"
export VERCEL_AUTOMATION_BYPASS_SECRET=<same-vercel-bypass-secret-if-protected>
just test-e2e-workerless-vercel-smoke https://<deployment-host>
```

Register an existing AGNT5 deployment manually when sync is not the right fit:

```bash
agnt5 serverless register \
  https://<deployment-host> \
  --provider vercel \
  --signing-secret-env AGNT5_SERVERLESS_SIGNING_SECRET \
  --invoke-header-env x-vercel-protection-bypass=VERCEL_AUTOMATION_BYPASS_SECRET \
  --request-timeout-ms 10000 \
  --yield-before-timeout-ms 1000
```

`--invoke-header-env` stores provider invoke headers as an encrypted AGNT5
secret ref. Use it for Vercel Deployment Protection's
`x-vercel-protection-bypass` automation header when the endpoint is protected.

Run the example workflows after sync or register activates the deployment:

```bash
agnt5 run workflow hello --input '{"name":"Ada"}'
agnt5 run workflow research --input '{"title":"AGNT5"}'
```

For local Next.js development, keep the same route files and point
`agnt5 serverless register` at the local dev URL.
