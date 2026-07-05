import { serve as serveNode } from "@hono/node-server";
import { Hono } from "hono";
import { serve, workflow } from "@agnt5/sdk/serverless";

type Bindings = {
  AGNT5_SERVERLESS_SIGNING_SECRET?: string;
  GIT_SHA?: string;
  CF_PAGES_COMMIT_SHA?: string;
  VERCEL_GIT_COMMIT_SHA?: string;
};

type HonoEnv = {
  Bindings: Bindings;
};

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

const nodeEnv = (): Bindings =>
  typeof process !== "undefined" ? process.env : {};

const agnt5Workerless = serve<Bindings>({
  serviceName: "agnt5-serverless-hono",
  serviceVersion: nodeEnv().GIT_SHA ?? nodeEnv().VERCEL_GIT_COMMIT_SHA ?? nodeEnv().CF_PAGES_COMMIT_SHA ?? "local",
  signingSecret: (_request, env) =>
    env?.AGNT5_SERVERLESS_SIGNING_SECRET ?? nodeEnv().AGNT5_SERVERLESS_SIGNING_SECRET,
  workflows: [hello, research],
});

const app = new Hono<HonoEnv>();

const handleAgnt5 = (env: Bindings | undefined, request: Request): Promise<Response> =>
  agnt5Workerless.fetch(request, env ?? nodeEnv());

app.get("/.well-known/agnt5", (c) => handleAgnt5(c.env, c.req.raw));
app.post("/agnt5/invoke", (c) => handleAgnt5(c.env, c.req.raw));

export default app;

if (typeof process !== "undefined" && process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const port = Number(process.env.PORT ?? "8787");
  serveNode({ fetch: app.fetch, port }, ({ port }) => {
    console.log(`AGNT5 Hono serverless endpoint listening on http://127.0.0.1:${port}`);
  });
}
