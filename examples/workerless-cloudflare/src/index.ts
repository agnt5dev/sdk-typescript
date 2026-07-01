import { serveCloudflare, workflow } from '@agnt5/sdk/workerless/cloudflare';

interface Env {
  AGNT5_WORKERLESS_SIGNING_SECRET?: string;
}

const hello = workflow('hello', async (_ctx, input: { name?: string }) => ({
  message: `hello ${input.name ?? 'world'}`,
}));

const research = workflow('research', async (ctx, input: { title?: string }) => {
  const page = await ctx.step('fetch', async () => ({
    title: input.title ?? 'AGNT5',
    fetched_at: new Date().toISOString(),
  }));

  if (ctx.attempt === 0) {
    await ctx.yieldIfNeeded();
  }

  return {
    summary: `summary:${page.title}`,
  };
});

export default serveCloudflare<Env>({
  serviceName: 'agnt5-workerless-cloudflare',
  serviceVersion: 'm3',
  signingSecret: (env) => env?.AGNT5_WORKERLESS_SIGNING_SECRET,
  workflows: [hello, research],
});
