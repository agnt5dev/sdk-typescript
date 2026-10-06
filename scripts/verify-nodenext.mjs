import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const fixture = mkdtempSync(join(tmpdir(), 'agnt5-nodenext-'));
try {
  mkdirSync(join(fixture, 'node_modules', '@agnt5'), { recursive: true });
  symlinkSync(root, join(fixture, 'node_modules', '@agnt5', 'sdk'), 'junction');
  writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
  writeFileSync(join(fixture, 'consumer.ts'), `
import { fn } from '@agnt5/sdk';
import type { Context } from '@agnt5/sdk';
const double = fn<{ n: number }, number>('double').run(async (_ctx, input) => input.n * 2);
declare const ctx: Context;
const value: number = await double(ctx, { n: 2 });
// @ts-expect-error A function cannot be assigned to an arbitrary object.
const invalid: { anything: true } = double;
// @ts-expect-error The function input must retain its declared type.
await double(ctx, { n: 'wrong' });
// @ts-expect-error The function output must retain its declared type.
const wrongOutput: string = await double(ctx, { n: 2 });
`);
  const result = spawnSync(process.execPath, [require.resolve('typescript/lib/tsc.js'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', join(fixture, 'consumer.ts')], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(fixture, { recursive: true, force: true }); }
