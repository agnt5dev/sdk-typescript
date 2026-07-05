import { serve, workflow } from '@agnt5/sdk/serverless';

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

export const agnt5Workerless = serve({
  serviceName: 'agnt5-serverless-vercel',
  serviceVersion: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.VERCEL_URL ?? 'local',
  signingSecret: () => process.env.AGNT5_SERVERLESS_SIGNING_SECRET,
  workflows: [hello, research],
});
