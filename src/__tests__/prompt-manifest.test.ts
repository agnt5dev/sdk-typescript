import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePromptFromManifest } from '../prompt-manifest.js';
import type { GenerateRequest, Prompt } from '../lm.js';

const originalEnv = { ...process.env };
let tempDir: string | undefined;

afterEach(() => {
  process.env = { ...originalEnv };
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('prompt manifest resolution', () => {
  it('resolves production prompts from prompts/<id>.mdx', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'agnt5-prompts-'));
    mkdirSync(join(tempDir, 'prompts'));
    writeFileSync(
      join(tempDir, 'prompts', 'support_reply.mdx'),
      `---
id: support_reply
version: 3
version_id: version-3
model: gpt-4o-mini
temperature: 0.2
max_tokens: 60
variables:
  - customer.name
  - topic
response_format: text
---

<System>
Be concise.
</System>

<User>
Reply to {{customer.name}} about {{topic}}.
</User>
`,
    );
    process.env.AGNT5_ENVIRONMENT = 'production';
    process.env.AGNT5_PROMPTS_MANIFEST = tempDir;

    const request: GenerateRequest = {
      model: 'openai/gpt-4o-mini',
      prompt: { id: 'support_reply' },
    };
    const prompt: Prompt = {
      id: 'support_reply',
      model: 'openai/gpt-4o',
      temperature: 0.6,
      maxOutputTokens: 33,
      topP: 0.5,
      variables: { customer: { name: 'Ada' } as any, topic: 'shipping' },
    };

    const resolved = resolvePromptFromManifest(request, prompt);

    expect(resolved?.model).toBe('openai/gpt-4o');
    expect(resolved?.prompt).toBeUndefined();
    expect(resolved?.promptRef).toBeUndefined();
    expect(resolved?.config?.temperature).toBe(0.6);
    expect(resolved?.config?.maxOutputTokens).toBe(33);
    expect(resolved?.config?.topP).toBe(0.5);
    expect(resolved?.messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Reply to Ada about shipping.' },
    ]);
  });

  it('rejects JSON prompt override files', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'agnt5-prompts-'));
    const promptPath = join(tempDir, 'support_reply.json');
    writeFileSync(promptPath, '{}');
    process.env.AGNT5_PROMPT_OVERRIDE = promptPath;

    const request: GenerateRequest = {
      model: 'openai/gpt-4o-mini',
      prompt: { id: 'support_reply' },
    };

    expect(() => resolvePromptFromManifest(request, { id: 'support_reply' })).toThrow(
      /\.md or \.mdx/,
    );
  });
});
