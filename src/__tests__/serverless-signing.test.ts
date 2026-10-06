import { beforeEach, expect, it, vi } from 'vitest';
import { serveCloudflare } from '../serverless-cloudflare.js';
import { serve, workflow } from '../serverless.js';
import { WorkflowRegistry } from '../workflow.js';

beforeEach(() => {
  WorkflowRegistry.clear();
});

function unsignedInvoke(componentName: string): Request {
  return new Request('https://example.test/agnt5/invoke', {
    method: 'POST',
    body: JSON.stringify({
      protocol_version: 'workerless.v1',
      run_id: 'probe',
      component_type: 'workflow',
      component_name: componentName,
      input: {},
    }),
  });
}

it.each([
  ['omitted', undefined],
  ['empty', ''],
  ['blank', ' \t\n'],
  ['empty resolver', () => undefined],
  ['empty async resolver', async () => ''],
] as const)('rejects invokes with %s signing secret before executing user code', async (_name, signingSecret) => {
  const run = vi.fn(async () => 'executed');
  const probe = workflow('probe', run);
  const handler = serve({ workflows: [probe], signingSecret });
  const manifest = await handler.fetch(new Request('https://example.test/.well-known/agnt5'));
  expect(manifest.status).toBe(200);
  const response = await handler.fetch(unsignedInvoke('probe'));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: 'WORKERLESS_SIGNING_SECRET_REQUIRED' } });
  expect(run).not.toHaveBeenCalled();
});

it('warns at startup and permits explicitly unsigned local invokes', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const probe = workflow('probe', async () => 'executed');
    const handler = serve({ workflows: [probe], allowUnsigned: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('allowUnsigned: true permits unsigned invokes'));
    const response = await handler.fetch(unsignedInvoke('probe'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ output: 'executed' });
  } finally {
    warn.mockRestore();
  }
});

it('does not let allowUnsigned bypass a configured signing secret', async () => {
  const run = vi.fn(async () => 'executed');
  const probe = workflow('probe', run);
  const handler = serve({ workflows: [probe], signingSecret: 'fixture-secret', allowUnsigned: true });
  const response = await handler.fetch(unsignedInvoke('probe'));
  expect(response.status).toBe(401);
  expect(run).not.toHaveBeenCalled();
});

it('warns at startup when the secret is omitted', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    serve({ workflows: [] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('signing secret is missing; invokes are rejected'));
  } finally {
    warn.mockRestore();
  }
});

it('warns once when a request-time environment binding is missing', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const handler = serve<{ SECRET?: string }>({ workflows: [], signingSecret: (_request, env) => env?.SECRET });
    expect(warn).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i++) {
      const response = await handler.fetch(unsignedInvoke('probe'), {});
      expect(response.status).toBe(503);
    }
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});


it.each([false, true])('Cloudflare preserves allowUnsigned=%s with an empty environment binding', async (allowUnsigned) => {
  const run = vi.fn(async () => 'executed');
  const probe = workflow('probe', run);
  const handler = serveCloudflare<{ SECRET?: string }>({
    workflows: [probe], allowUnsigned, signingSecret: (env) => env?.SECRET,
  });
  const response = await handler.fetch(unsignedInvoke('probe'), {});
  expect(response.status).toBe(allowUnsigned ? 200 : 503);
  expect(run).toHaveBeenCalledTimes(allowUnsigned ? 1 : 0);
});
