import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForPackage } from './verify-registry-release.mjs';
const metadata = () => new Response(JSON.stringify({
  name: '@agnt5/sdk-test', version: '0.9.1',
  dist: { tarball: 'https://registry.npmjs.org/test.tgz' },
}));

test('staged metadata cannot pass the publication gate', async () => {
  await assert.rejects(waitForPackage('@agnt5/sdk-test', '0.9.1', {
    fetcher: async () => new Response('', { status: 404 }),
    attempts: 2, pause: async () => {},
  }), /metadata HTTP 404/);
});
test('metadata alone cannot pass without a public tarball', async () => {
  await assert.rejects(waitForPackage('@agnt5/sdk-test', '0.9.1', {
    fetcher: async (_url, options) => options.method === 'HEAD'
      ? new Response('', { status: 404 }) : metadata(),
    attempts: 1,
  }), /tarball HTTP 404/);
});
test('waits for propagation and verifies the tarball', async () => {
  let requests = 0;
  await waitForPackage('@agnt5/sdk-test', '0.9.1', {
    fetcher: async (_url, options) => {
      requests++;
      if (requests === 1) return new Response('', { status: 404 });
      return options.method === 'HEAD' ? new Response(null) : metadata();
    }, attempts: 2, pause: async () => {},
  });
  assert.equal(requests, 3);
});
