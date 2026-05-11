/**
 * ESM compatibility smoke test for the scorer module.
 *
 * The package is `"type": "module"`. CommonJS `require()` calls inside
 * `src/scorer.ts` compile fine under tsc and pass under vitest (because
 * vite rewrites them) but throw `ReferenceError: require is not defined`
 * when the compiled `dist/native/scorer.js` is loaded by Node's pure
 * ESM loader.
 *
 * This test guards against re-introducing that class of bug by reading
 * the compiled-equivalent source (`scorer.ts`) and asserting it
 * contains no bare `require(` calls outside of comments and strings.
 * If you need a runtime module loaded at scorer-call time, use
 * `await import(...)`.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('scorer.ts ESM compatibility', () => {
  it('contains no bare require() calls (must use static or dynamic import)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../scorer.ts'),
      'utf8',
    );
    // Strip line comments and block comments before searching so the
    // word "require" in JSDoc doesn't trip the check.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    // Detect `require(...)` only when it appears as a call expression.
    // Allow `requireXxx(` (e.g., a method named requireConfig).
    const matches = stripped.match(/(^|[^A-Za-z0-9_])require\s*\(/g);

    expect(matches, `bare require() found in scorer.ts: ${matches?.join(', ')}`).toBeNull();
  });
});
