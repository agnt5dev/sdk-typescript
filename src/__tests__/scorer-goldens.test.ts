/**
 * Cross-language golden parity tests for builtin scorers.
 *
 * Reads `sdk/test-fixtures/eval/builtin_goldens.json` (shared with the
 * Rust and Python SDKs) and asserts each row produces the same
 * `(score, passed)` here as in the other two SDKs. Rows with a `label`
 * field also enforce label equality.
 *
 * If a row fails here but passes in Rust / Python, the TypeScript
 * builtin has drifted — fix TS, not the fixture.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  contains,
  exactMatch,
  jsonSchema,
  jsonValid,
  levenshtein,
  numericRange,
  regexMatch,
} from '../scorer.js';
import type { ScorerRequest, ScorerResult } from '../scorer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Golden {
  name: string;
  scorer: string;
  input: ScorerRequest;
  expect: { score: number; passed: boolean; label?: string };
}

const fixturePath = path.resolve(__dirname, '../../test-fixtures/eval/builtin_goldens.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as { cases: Golden[] };

function runScorer(name: string, req: ScorerRequest): ScorerResult {
  // No adapters here: if a row passes in Rust + Python but fails here,
  // the TypeScript symbol's shape has drifted — fix the symbol.
  switch (name) {
    case 'exact_match':
      return exactMatch(req);
    case 'contains':
      return contains(req);
    case 'json_valid':
      return jsonValid(req);
    case 'json_schema':
      return jsonSchema(req);
    case 'numeric_range':
      return numericRange(req);
    case 'regex_match':
      return regexMatch(req);
    case 'levenshtein':
      return levenshtein(req);
    default:
      throw new Error(`unknown scorer in goldens: ${name}`);
  }
}

describe('Cross-language golden parity', () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const result = runScorer(c.scorer, c.input);
      expect(result.score).toBeCloseTo(c.expect.score, 9);
      expect(result.passed).toBe(c.expect.passed);
      if (c.expect.label !== undefined) {
        expect(result.label).toBe(c.expect.label);
      }
    });
  }
});
