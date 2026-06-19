import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent } from '../agent.js';
import {
  Skill,
  discoverSkills,
  makeLoadSkillTool,
  renderCatalog,
  resolveSkills,
} from '../skills.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agnt5-skills-'));
}

function writeSkill(
  root: string,
  folder: string,
  name: string,
  description: string,
  body = 'Do the thing.',
): string {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  return dir;
}

const stubModel = { generate: async () => ({ text: '', finishReason: 'stop' }) } as any;

describe('Skill.fromPath', () => {
  it('parses frontmatter and body', () => {
    const root = tmpRoot();
    const dir = writeSkill(root, 'pdf', 'pdf-extraction', 'Extract from PDFs', '# Body\nrun scripts/x.py');
    const skill = Skill.fromPath(dir);
    expect(skill.name).toBe('pdf-extraction');
    expect(skill.description).toBe('Extract from PDFs');
    expect(skill.instructions).toContain('run scripts/x.py');
    expect(skill.resourcesDir).toBe(dir);
  });

  it('handles quoted values and colons', () => {
    const root = tmpRoot();
    const dir = join(root, 's');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: "quoted"\ndescription: 'has: colon'\n---\nbody\n`);
    const skill = Skill.fromPath(dir);
    expect(skill.name).toBe('quoted');
    expect(skill.description).toBe('has: colon');
  });

  it('throws on missing file', () => {
    expect(() => Skill.fromPath(join(tmpRoot(), 'nope'))).toThrow();
  });

  it('throws when description is missing', () => {
    const root = tmpRoot();
    const dir = join(root, 's');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: only-name\n---\nbody\n`);
    expect(() => Skill.fromPath(dir)).toThrow(/description/);
  });
});

describe('discoverSkills', () => {
  it('skips malformed skills', () => {
    const root = tmpRoot();
    writeSkill(root, 'good', 'good', 'A good skill');
    const bad = join(root, 'bad');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'SKILL.md'), `---\nname: incomplete\n---\n`);
    mkdirSync(join(root, 'not-a-skill'), { recursive: true });

    const found = discoverSkills(root);
    expect([...found.keys()]).toEqual(['good']);
  });
});

describe('resolveSkills', () => {
  it('returns empty without dir', () => {
    expect(resolveSkills(undefined, undefined).size).toBe(0);
  });

  it('loads all when no selection given', () => {
    const root = tmpRoot();
    writeSkill(root, 'a', 'a', 'A');
    writeSkill(root, 'b', 'b', 'B');
    expect([...resolveSkills(undefined, root).keys()].sort()).toEqual(['a', 'b']);
  });

  it('selects a named subset', () => {
    const root = tmpRoot();
    writeSkill(root, 'a', 'a', 'A');
    writeSkill(root, 'b', 'b', 'B');
    writeSkill(root, 'c', 'c', 'C');
    expect([...resolveSkills(['a', 'c'], root).keys()].sort()).toEqual(['a', 'c']);
  });

  it('lists available names on unknown', () => {
    const root = tmpRoot();
    writeSkill(root, 'a', 'a', 'A');
    expect(() => resolveSkills(['missing'], root)).toThrow(/Available: a/);
  });

  it('throws when a name is given without a dir', () => {
    expect(() => resolveSkills(['a'], undefined)).toThrow(/no skillsDir/);
  });

  it('passes through Skill objects', () => {
    const root = tmpRoot();
    const dir = writeSkill(root, 'a', 'a', 'A');
    const obj = Skill.fromPath(dir);
    const resolved = resolveSkills([obj], undefined);
    expect(resolved.get('a')).toBe(obj);
  });

  it('resolves a folder name that differs from the skill name', () => {
    const root = tmpRoot();
    writeSkill(root, 'folder-x', 'real-name', 'Real');
    expect([...resolveSkills(['folder-x'], root).keys()]).toEqual(['real-name']);
  });
});

describe('renderCatalog', () => {
  it('is blank when empty', () => {
    expect(renderCatalog(new Map())).toBe('');
  });

  it('lists name and description', () => {
    const root = tmpRoot();
    writeSkill(root, 'a', 'pdf', 'Extract PDFs');
    writeSkill(root, 'b', 'sql', 'Run SQL');
    const catalog = renderCatalog(resolveSkills(['pdf', 'sql'], root));
    expect(catalog).toContain('<skills>');
    expect(catalog).toContain('- pdf: Extract PDFs');
    expect(catalog).toContain('- sql: Run SQL');
    expect(catalog).toContain('load_skill(skill_name)');
  });
});

describe('makeLoadSkillTool', () => {
  it('returns the skill body', async () => {
    const root = tmpRoot();
    writeSkill(root, 'a', 'a', 'A', 'Step 1. Do it.');
    const tool = makeLoadSkillTool(resolveSkills(['a'], root));
    const out = await tool.handler({} as any, { skill_name: 'a' });
    expect(out).toContain('Step 1. Do it.');
  });

  it('returns a helpful message for unknown skills', async () => {
    const root = tmpRoot();
    writeSkill(root, 'a', 'a', 'A');
    const tool = makeLoadSkillTool(resolveSkills(['a'], root));
    const out = await tool.handler({} as any, { skill_name: 'missing' });
    expect(out).toContain('Unknown skill');
    expect(out).toContain('a');
  });

  it('materializes bundled resources into the sandbox', async () => {
    const root = tmpRoot();
    const dir = writeSkill(root, 'a', 'a', 'A', 'run scripts/x.py');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'x.py'), "print('hi')");

    const writes = new Map<string, any>();
    const sandbox = { writeFile: async (p: string, c: any) => writes.set(p, c) } as any;
    const tool = makeLoadSkillTool(resolveSkills(['a'], root), sandbox);
    const out = await tool.handler({} as any, { skill_name: 'a' });

    expect(writes.has('skills/a/scripts/x.py')).toBe(true);
    expect(writes.has('skills/a/SKILL.md')).toBe(false);
    expect(out).toContain('Bundled resources');
    expect(out).toContain('skills/a/scripts/x.py');
  });

  it('returns the plain body when there is no sandbox', async () => {
    const root = tmpRoot();
    const dir = writeSkill(root, 'a', 'a', 'A', 'body text');
    writeFileSync(join(dir, 'extra.txt'), 'data');
    const tool = makeLoadSkillTool(resolveSkills(['a'], root));
    const out = await tool.handler({} as any, { skill_name: 'a' });
    expect(out.trim()).toBe('body text');
  });

  it('emits a skill.loaded event', async () => {
    const root = tmpRoot();
    writeSkill(root, 'a', 'a', 'A', 'instructions here');
    const events: any[] = [];
    const ctx = { correlationId: 'tool-call-1', emit: async (e: any) => void events.push(e) } as any;
    const tool = makeLoadSkillTool(resolveSkills(['a'], root));
    await tool.handler(ctx, { skill_name: 'a' });

    const loaded = events.filter((e) => e.eventType === 'skill.loaded');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].skillName).toBe('a');
    expect(loaded[0].instructionsLength).toBe('instructions here'.length);
    expect(loaded[0].resourcesMaterialized).toBe(0);
    expect(loaded[0].parentCorrelationId).toBe('tool-call-1');
  });

  it('counts materialized resources in the event', async () => {
    const root = tmpRoot();
    const dir = writeSkill(root, 'a', 'a', 'A');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'x.py'), 'x');
    writeFileSync(join(dir, 'ref.md'), 'ref');

    const events: any[] = [];
    const sandbox = { writeFile: async () => {} } as any;
    const ctx = { emit: async (e: any) => void events.push(e) } as any;
    const tool = makeLoadSkillTool(resolveSkills(['a'], root), sandbox);
    await tool.handler(ctx, { skill_name: 'a' });

    const loaded = events.find((e) => e.eventType === 'skill.loaded');
    expect(loaded.resourcesMaterialized).toBe(2);
  });

  it('emits no event for an unknown skill', async () => {
    const root = tmpRoot();
    writeSkill(root, 'a', 'a', 'A');
    const events: any[] = [];
    const ctx = { emit: async (e: any) => void events.push(e) } as any;
    const tool = makeLoadSkillTool(resolveSkills(['a'], root));
    await tool.handler(ctx, { skill_name: 'missing' });
    expect(events.filter((e) => e.eventType === 'skill.loaded')).toHaveLength(0);
  });
});

describe('Agent skill wiring', () => {
  it('registers load_skill and injects only the selected catalog', () => {
    const root = tmpRoot();
    writeSkill(root, 'a', 'pdf', 'Extract PDFs');
    writeSkill(root, 'b', 'sql', 'Run SQL');

    const agent = new Agent({
      name: 't',
      model: stubModel,
      instructions: 'Base instructions.',
      skills: ['pdf'],
      skillsDir: root,
    });

    expect((agent as any).tools.has('load_skill')).toBe(true);
    expect([...(agent as any).skills.keys()]).toEqual(['pdf']);

    const prompt = (agent as any).composeSystemPrompt();
    expect(prompt).toContain('Base instructions.');
    expect(prompt).toContain('<skills>');
    expect(prompt).toContain('- pdf: Extract PDFs');
    expect(prompt).not.toContain('sql');
  });

  it('leaves a skill-less agent unchanged', () => {
    const agent = new Agent({ name: 't', model: stubModel, instructions: 'Base instructions.' });
    expect((agent as any).tools.has('load_skill')).toBe(false);
    expect((agent as any).skills.size).toBe(0);
    expect((agent as any).composeSystemPrompt()).toBe('Base instructions.');
  });
});
