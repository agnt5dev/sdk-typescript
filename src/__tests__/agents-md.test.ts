import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Agent } from '../agent.js';
import { discoverAgentsMd, loadAgentsMd, renderGuidance } from '../agents-md.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agnt5-agentsmd-'));
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const stubModel = { generate: async () => ({ text: '', finishReason: 'stop' }) } as any;

describe('loadAgentsMd', () => {
  it('is empty when undefined', () => {
    expect(loadAgentsMd(undefined)).toBe('');
  });

  it('loads a file path', () => {
    const root = tmpRoot();
    write(join(root, 'AGENTS.md'), 'Be concise.');
    expect(loadAgentsMd(join(root, 'AGENTS.md'))).toBe('Be concise.');
  });

  it('loads a directory via its AGENTS.md', () => {
    const root = tmpRoot();
    write(join(root, 'AGENTS.md'), 'Repo rules.');
    expect(loadAgentsMd(root)).toBe('Repo rules.');
  });

  it('concatenates a list in order', () => {
    const root = tmpRoot();
    write(join(root, 'AGENTS.md'), 'Root rules.');
    write(join(root, 'sub', 'AGENTS.md'), 'Sub rules.');
    const out = loadAgentsMd([join(root, 'AGENTS.md'), join(root, 'sub', 'AGENTS.md')]);
    expect(out).toBe('Root rules.\n\nSub rules.');
  });

  it('skips missing sources', () => {
    const root = tmpRoot();
    write(join(root, 'AGENTS.md'), 'Only one.');
    const out = loadAgentsMd([join(root, 'AGENTS.md'), join(root, 'missing', 'AGENTS.md')]);
    expect(out).toBe('Only one.');
  });
});

describe('renderGuidance', () => {
  it('is blank when empty', () => {
    expect(renderGuidance('')).toBe('');
  });

  it('wraps content in a project-guidance block', () => {
    const block = renderGuidance('Rules.');
    expect(block.startsWith('<project-guidance>')).toBe(true);
    expect(block.endsWith('</project-guidance>')).toBe(true);
    expect(block).toContain('Rules.');
  });
});

describe('discoverAgentsMd', () => {
  it('walks up to the .git boundary, outermost first', () => {
    const root = tmpRoot();
    mkdirSync(join(root, '.git'), { recursive: true });
    write(join(root, 'AGENTS.md'), 'root');
    write(join(root, 'a', 'b', 'AGENTS.md'), 'leaf');
    write(join(root, '..', 'AGENTS.md'), 'outside-repo');

    const found = discoverAgentsMd(join(root, 'a', 'b'));

    expect(found[0]).toBe(join(root, 'AGENTS.md')); // outermost (root) first
    expect(found[found.length - 1]).toBe(join(root, 'a', 'b', 'AGENTS.md')); // most specific last
    expect(found.some((p) => p.includes('outside-repo'))).toBe(false);
  });
});

describe('Agent guidance wiring', () => {
  it('injects guidance before the skills catalog', () => {
    const root = tmpRoot();
    write(join(root, 'AGENTS.md'), 'Follow repo conventions.');
    write(join(root, 'skills', 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: Extract PDFs\n---\nbody');

    const agent = new Agent({
      name: 't',
      model: stubModel,
      instructions: 'Base.',
      agentsMd: root,
      skills: ['pdf'],
      skillsDir: join(root, 'skills'),
    });

    const prompt = (agent as any).composeSystemPrompt();
    expect(prompt).toContain('Base.');
    expect(prompt).toContain('<project-guidance>');
    expect(prompt).toContain('Follow repo conventions.');
    expect(prompt).toContain('<skills>');
    expect(prompt.indexOf('<project-guidance>')).toBeLessThan(prompt.indexOf('<skills>'));
  });

  it('leaves a guidance-less agent unchanged', () => {
    const agent = new Agent({ name: 't', model: stubModel, instructions: 'Base.' });
    expect((agent as any).agentsMdGuidance).toBe('');
    expect((agent as any).composeSystemPrompt()).toBe('Base.');
  });
});
