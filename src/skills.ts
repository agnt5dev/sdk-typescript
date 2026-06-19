/**
 * Skills - on-demand capability loading for agents.
 *
 * A *skill* is a folder containing a `SKILL.md` file (Claude's open format):
 * YAML-style frontmatter with `name` and `description`, followed by a markdown
 * body of instructions. Optional sibling files (scripts, reference docs) are the
 * skill's bundled resources.
 *
 * Skills follow progressive disclosure: only `name` + `description` sit in the
 * agent's context (the *catalog*); the full body is loaded on demand when the
 * agent decides the skill is relevant. This keeps prompts small while giving the
 * agent access to many capabilities.
 *
 * @example
 * ```typescript
 * // Curated subset by name, resolved against a shared pool directory
 * new Agent({ ..., skillsDir: './skills', skills: ['pdf-extraction', 'sql-reporting'] });
 *
 * // Load every skill in the pool (single-agent convenience)
 * new Agent({ ..., skillsDir: './skills' });
 *
 * // Self-contained Skill objects, no pool directory needed
 * new Agent({ ..., skills: [Skill.fromPath('./skills/pdf-extraction')] });
 * ```
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { randomUUID } from 'crypto';

import { Tool } from './tool.js';
import { skillLoaded } from './events.js';
import type { Context } from './types.js';
import type { Sandbox } from './sandbox.js';

const SKILL_FILE = 'SKILL.md';

/** A skill selection item: a name resolved against `skillsDir`, or a `Skill`. */
export type SkillInput = string | Skill;

/**
 * A loadable agent capability parsed from a `SKILL.md` folder.
 */
export class Skill {
  /** Catalog identifier the agent uses to load the skill (frontmatter `name`). */
  readonly name: string;
  /** One-line trigger hint; lives in the agent's context at all times. */
  readonly description: string;
  /** The markdown body loaded into context on demand. */
  readonly instructions: string;
  /** Folder containing `SKILL.md` and bundled files; undefined if constructed inline. */
  readonly resourcesDir?: string;

  constructor(name: string, description: string, instructions: string, resourcesDir?: string) {
    this.name = name;
    this.description = description;
    this.instructions = instructions;
    this.resourcesDir = resourcesDir;
  }

  /**
   * Parse a skill from a folder containing `SKILL.md` (or the file itself).
   *
   * @throws if no `SKILL.md` exists, or frontmatter is missing `name`/`description`.
   */
  static fromPath(path: string): Skill {
    const skillFile =
      existsSync(path) && statSync(path).isDirectory() ? join(path, SKILL_FILE) : path;
    if (!existsSync(skillFile) || !statSync(skillFile).isFile()) {
      throw new Error(`No ${SKILL_FILE} found at ${path}`);
    }

    const text = readFileSync(skillFile, 'utf-8');
    const { meta, body } = parseFrontmatter(text);

    if (!meta.name) {
      throw new Error(`${skillFile}: frontmatter is missing required 'name'`);
    }
    if (!meta.description) {
      throw new Error(`${skillFile}: frontmatter is missing required 'description'`);
    }

    return new Skill(meta.name, meta.description, body.trim(), join(skillFile, '..'));
  }
}

/**
 * Split `SKILL.md` text into a frontmatter map and the markdown body.
 *
 * Supports the minimal subset skills need: a leading `---` fenced block of
 * single-line `key: value` pairs (values may be single- or double-quoted). No
 * YAML dependency. Text without a frontmatter block yields an empty map and the
 * full text as body.
 */
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { meta: {}, body: text };
  }

  const meta: Record<string, string> = {};
  let bodyStart = lines.length;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      bodyStart = i + 1;
      break;
    }
    const line = lines[i].trim();
    const colon = line.indexOf(':');
    if (!line || line.startsWith('#') || colon === -1) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^['"]|['"]$/g, '');
    meta[key] = value;
  }

  return { meta, body: lines.slice(bodyStart).join('\n') };
}

/**
 * Parse every skill in a pool directory, keyed by skill name.
 *
 * A skill is any immediate subfolder containing a `SKILL.md`. Malformed skills
 * are skipped with a warning rather than failing discovery.
 */
export function discoverSkills(skillsDir: string): Map<string, Skill> {
  if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) {
    throw new Error(`skillsDir does not exist: ${skillsDir}`);
  }

  const found = new Map<string, Skill>();
  for (const entry of readdirSync(skillsDir).sort()) {
    const child = join(skillsDir, entry);
    if (!statSync(child).isDirectory() || !existsSync(join(child, SKILL_FILE))) {
      continue;
    }
    try {
      const skill = Skill.fromPath(child);
      found.set(skill.name, skill);
    } catch (err) {
      console.warn(`Skipping malformed skill at ${child}: ${(err as Error).message}`);
    }
  }
  return found;
}

/**
 * Resolve an agent's skill selection into a `name -> Skill` map.
 *
 * - Items may be names (resolved against `skillsDir`) or `Skill` objects.
 * - `skills` omitted with a `skillsDir` loads every skill in the pool.
 * - Neither provided yields an empty map (skills disabled — no behavior change).
 *
 * @throws if a named skill is not found (lists available names), or a name is
 *   given without a pool.
 */
export function resolveSkills(
  skills: SkillInput[] | undefined,
  skillsDir: string | undefined,
): Map<string, Skill> {
  if (skills === undefined) {
    return skillsDir !== undefined ? discoverSkills(skillsDir) : new Map();
  }

  let available: Map<string, Skill> | undefined;
  const resolved = new Map<string, Skill>();
  for (const item of skills) {
    if (item instanceof Skill) {
      resolved.set(item.name, item);
      continue;
    }
    if (skillsDir === undefined) {
      throw new Error(
        `Skill '${item}' given by name but no skillsDir was provided to resolve it against`,
      );
    }
    if (available === undefined) {
      available = discoverSkills(skillsDir);
    }
    let skill = available.get(item);
    if (skill === undefined) {
      // Fall back to a direct folder match (folder name != frontmatter name)
      const folder = join(skillsDir, item);
      if (existsSync(join(folder, SKILL_FILE))) {
        skill = Skill.fromPath(folder);
      } else {
        const names = [...available.keys()].sort().join(', ') || '(none)';
        throw new Error(`Skill '${item}' not found in ${skillsDir}. Available: ${names}`);
      }
    }
    resolved.set(skill.name, skill);
  }
  return resolved;
}

/**
 * Render the always-present `<skills>` catalog block for the system prompt.
 *
 * Only `name` + `description` are included — the progressive-disclosure
 * contract. Returns an empty string when there are no skills.
 */
export function renderCatalog(skills: Map<string, Skill>): string {
  if (skills.size === 0) {
    return '';
  }

  const lines = [
    '<skills>',
    "You have access to the following skills. When a task matches a skill's " +
      'purpose, call load_skill(skill_name) to load its full instructions before ' +
      'proceeding.',
    '',
  ];
  for (const skill of skills.values()) {
    lines.push(`- ${skill.name}: ${skill.description}`);
  }
  lines.push('</skills>');
  return lines.join('\n');
}

/** Recursively list every file path under `dir`. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (st.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Copy a skill's bundled files into the sandbox so its scripts can run.
 *
 * Files are written under `skills/<name>/` preserving their relative layout,
 * excluding `SKILL.md` itself. Writes are idempotent. Returns `[base, paths]`,
 * or `undefined` when there is no sandbox or no resources to copy.
 */
async function materializeResources(
  ctx: Context,
  skill: Skill,
  sandbox: Sandbox | undefined,
): Promise<[string, string[]] | undefined> {
  const active = sandbox ?? (ctx as any).sandbox;
  if (!active || !skill.resourcesDir) {
    return undefined;
  }

  const base = `skills/${skill.name}`;
  const written: string[] = [];
  for (const file of walkFiles(skill.resourcesDir)) {
    if (basename(file) === SKILL_FILE) {
      continue;
    }
    const rel = relative(skill.resourcesDir, file).split(/[\\/]/).join('/');
    const dest = `${base}/${rel}`;
    await active.writeFile(dest, readFileSync(file));
    written.push(dest);
  }

  return written.length > 0 ? [base, written] : undefined;
}

/**
 * Emit a `skill.loaded` event if the context supports emission. Guarded so the
 * tool handler stays callable with a minimal context (e.g. in unit tests).
 */
async function emitSkillLoaded(ctx: Context, skill: Skill, resourceCount: number): Promise<void> {
  const emit = (ctx as any).emit;
  if (typeof emit !== 'function') {
    return;
  }
  await emit.call(
    ctx,
    skillLoaded(randomUUID(), (ctx as any).correlationId ?? null, {
      skillName: skill.name,
      instructionsLength: skill.instructions.length,
      resourcesMaterialized: resourceCount,
    }),
  );
}

/**
 * Build the `load_skill` tool that loads a skill's body on demand.
 *
 * The returned tool closes over the agent's resolved `skills` map and its
 * sandbox. Invoking it returns the skill's instructions (progressive-disclosure
 * level 2) and, when a sandbox is present, materializes bundled resources.
 */
export function makeLoadSkillTool(skills: Map<string, Skill>, sandbox?: Sandbox): Tool {
  const handler = async (ctx: Context, args: Record<string, any>): Promise<string> => {
    const skillName = args.skill_name;
    const skill = skills.get(skillName);
    if (skill === undefined) {
      const names = [...skills.keys()].sort().join(', ') || '(none)';
      return `Unknown skill '${skillName}'. Available skills: ${names}`;
    }

    const materialized = await materializeResources(ctx, skill, sandbox);
    const resourceCount = materialized ? materialized[1].length : 0;
    await emitSkillLoaded(ctx, skill, resourceCount);

    if (!materialized) {
      return skill.instructions;
    }

    const [base, paths] = materialized;
    const files = paths.map((p) => `- ${p}`).join('\n');
    return (
      `${skill.instructions}\n\n---\n` +
      `Bundled resources are available in the sandbox under '${base}':\n${files}`
    );
  };

  return new Tool(
    'load_skill',
    'Load the full instructions for a skill by name. Call this when a task ' +
      'matches a skill listed in the <skills> catalog before proceeding.',
    handler,
    {
      inputSchema: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description: 'Name of the skill to load (as shown in the catalog).',
          },
        },
        required: ['skill_name'],
      },
    },
  );
}
