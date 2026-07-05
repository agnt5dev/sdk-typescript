import { serve, workflow } from "@agnt5/sdk/serverless";

const hello = workflow("hello", async (_ctx, input: { name?: string }) => ({
  message: `hello ${input.name ?? "world"}`,
}));

const research = workflow("research", async (ctx, input: { title?: string }) => {
  const page = await ctx.step("fetch", async () => ({
    title: input.title ?? "AGNT5",
    fetched_at: new Date().toISOString(),
  }));

  if (ctx.attempt === 0) {
    await ctx.yieldIfNeeded();
  }

  return {
    summary: `summary:${page.title}`,
  };
});

const agnt5Workerless = serve({
  serviceName: "agnt5-serverless-deno",
  serviceVersion: Deno.env.get("DENO_DEPLOYMENT_ID") ?? Deno.env.get("GIT_SHA") ?? "local",
  signingSecret: () => Deno.env.get("AGNT5_SERVERLESS_SIGNING_SECRET"),
  workflows: [hello, research],
});

const port = Number(Deno.env.get("PORT") ?? "8787");

Deno.serve({ port }, (request) => agnt5Workerless.fetch(request));
