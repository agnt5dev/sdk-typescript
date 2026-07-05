import { createServer } from 'node:http';
import { serveNode, workflow } from '@agnt5/sdk/serverless/node';

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

const agnt5Workerless = serveNode({
  serviceName: 'agnt5-serverless-node',
  serviceVersion: process.env.GIT_SHA ?? 'local',
  signingSecret: () => process.env.AGNT5_SERVERLESS_SIGNING_SECRET,
  workflows: [hello, research],
});

const server = createServer((request, response) => {
  agnt5Workerless(request, response).catch((error) => {
    response.statusCode = 500;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      status: 'failed',
      error: {
        code: 'WORKERLESS_NODE_HANDLER_ERROR',
        message: error instanceof Error ? error.message : String(error),
      },
    }));
  });
});

const port = Number(process.env.PORT ?? 8787);
server.listen(port, () => {
  console.log(`AGNT5 serverless endpoint listening on http://127.0.0.1:${port}`);
});
