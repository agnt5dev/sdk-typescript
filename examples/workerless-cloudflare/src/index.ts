import { serve, workflow } from '@agnt5/sdk/serverless';

interface Env {
  AGNT5_SERVERLESS_SIGNING_SECRET?: string;
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

export default serve<Env>({
  serviceName: 'agnt5-serverless-cloudflare',
  serviceVersion: 'm3',
  signingSecret: (_request, env) =>
    env?.AGNT5_SERVERLESS_SIGNING_SECRET ?? env?.AGNT5_WORKERLESS_SIGNING_SECRET,
  workflows: [hello, research],
});
