import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const repositoryRoot = resolve(import.meta.dirname, '../..');
const fixture = mkdtempSync(join(tmpdir(), 'agnt5-workerd-'));
const npmEnv = { ...process.env, npm_config_cache: join(fixture, '.npm-cache') };
process.env.WRANGLER_WRITE_LOGS = 'false';
const { unstable_dev } = await import('wrangler');
let worker;
let modelRequests = 0;

const modelServer = createServer((request, response) => {
  modelRequests += 1;
  assert.equal(request.url, '/v1/responses');
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    id: 'resp_workerd',
    created_at: 1,
    model: 'gpt-4.1-mini',
    status: 'completed',
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text: 'workerd-ok' }],
    }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }));
});

try {
  await new Promise((resolveReady, reject) => {
    modelServer.once('error', reject);
    modelServer.listen(0, '127.0.0.1', resolveReady);
  });
  const address = modelServer.address();
  assert(address && typeof address === 'object');

  const packOutput = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', fixture],
    { cwd: repositoryRoot, encoding: 'utf8', env: npmEnv },
  );
  const [{ filename }] = JSON.parse(packOutput);
  const tarball = join(fixture, filename);

  const packedSdk = join(fixture, 'node_modules', '@agnt5', 'sdk');
  mkdirSync(packedSdk, { recursive: true });
  execFileSync(
    'tar',
    ['-xzf', tarball, '--strip-components=1', '-C', packedSdk],
  );
  symlinkSync(
    join(repositoryRoot, 'node_modules', 'ajv'),
    join(fixture, 'node_modules', 'ajv'),
    'dir',
  );

  writeFileSync(join(fixture, 'worker.mjs'), `
    import { Agent, LM } from '@agnt5/sdk';
    import { serveCloudflare } from '@agnt5/sdk/serverless/cloudflare';

    const model = LM.openai({
      apiKey: 'workerd-test',
      baseUrl: 'http://127.0.0.1:${address.port}/v1',
    });
    const agent = new Agent({
      name: 'workerd-agent',
      model,
      modelName: 'openai/gpt-4.1-mini',
      instructions: 'Reply briefly.',
    });
    const cloudflare = serveCloudflare({ agents: [agent] });

    export default {
      async fetch() {
        const generated = await model.generate({
          model: 'openai/gpt-4.1-mini',
          messages: [{ role: 'user', content: 'Smoke test.' }],
        });
        return Response.json({
          text: generated.text,
          components: cloudflare.manifest().components.map(component => component.name),
        });
      },
    };
  `);

  const previousCwd = process.cwd();
  process.chdir(fixture);
  try {
    worker = await unstable_dev('worker.mjs', {
      local: true,
      compatibilityDate: '2026-07-01',
      compatibilityFlags: ['nodejs_compat'],
      experimental: { disableExperimentalWarning: true },
    });
    const response = await worker.fetch();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      text: 'workerd-ok',
      components: ['workerd-agent'],
    });
    assert.equal(modelRequests, 1);
  } finally {
    process.chdir(previousCwd);
  }
} finally {
  await worker?.stop();
  await new Promise(resolveClosed => modelServer.close(resolveClosed));
  rmSync(fixture, { recursive: true, force: true });
}

console.log('Packed SDK loaded and generated through the edge provider in workerd.');
