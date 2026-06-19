/**
 * AGENTS.md - always-on project/area guidance for agents.
 *
 * `AGENTS.md` is the open format for ambient operating instructions ("how to
 * work in this repo/area"). Unlike skills, it has no trigger metadata and is not
 * loaded on demand — its content sits in the agent's context at all times.
 *
 * It is hierarchical: a root `AGENTS.md` plus more specific ones deeper in the
 * tree, where the more specific guidance wins. This module loads explicit
 * file/directory sources and offers a bounded upward discovery helper.
 *
 * Pairs with on-demand skills (see `./skills.ts`): guidance is the always-on
 * layer, skills are the on-demand layer. Both feed the system prompt in
 * `./agent.ts`.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const AGENTS_FILE = 'AGENTS.md';

/** A guidance source: a file/dir path, or an ordered list (later = more specific). */
export type AgentsMdSource = string | string[];

/**
 * Walk upward from `startDir` collecting `AGENTS.md` files.
 *
 * Returned outermost-first so the most specific file (closest to `startDir`)
 * comes last and wins on concatenation. Bounded by the repo root (a directory
 * containing `.git`) when `stopAtGit` is set, otherwise by the filesystem root.
 */
export function discoverAgentsMd(startDir: string, stopAtGit = true): string[] {
  let dir = resolve(startDir);
  const found: string[] = [];
  for (;;) {
    const candidate = join(dir, AGENTS_FILE);
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      found.push(candidate);
    }
    if (stopAtGit && existsSync(join(dir, '.git'))) {
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break; // filesystem root
    }
    dir = parent;
  }
  found.reverse(); // outermost first, most specific last
  return found;
}

/**
 * Load and concatenate `AGENTS.md` content from one or more sources.
 *
 * Each source may be a file path or a directory (which uses its `AGENTS.md`).
 * An array is loaded in order, so later entries are treated as more specific.
 * Missing files are skipped. Returns `''` when nothing is found.
 */
export function loadAgentsMd(source?: AgentsMdSource): string {
  if (source === undefined) {
    return '';
  }
  const items = Array.isArray(source) ? source : [source];
  const parts: string[] = [];
  for (const item of items) {
    const file =
      existsSync(item) && statSync(item).isDirectory() ? join(item, AGENTS_FILE) : item;
    if (existsSync(file) && statSync(file).isFile()) {
      const text = readFileSync(file, 'utf-8').trim();
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join('\n\n');
}

/**
 * Wrap loaded guidance in the always-on `<project-guidance>` block. Returns `''`
 * for empty text so callers can append unconditionally.
 */
export function renderGuidance(text: string): string {
  return text ? `<project-guidance>\n${text}\n</project-guidance>` : '';
}
