import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePromptRefFromManifest } from '../prompt-manifest.js';
import type { GenerateRequest, PromptRef } from '../lm.js';

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
  it('resolves production prompt refs from prompts.lock', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'agnt5-prompts-'));
    writeFileSync(
      join(tempDir, 'prompts.lock'),
      JSON.stringify({
        schema_version: 'agnt5.prompts.v1',
        prompts: [
          {
            id: 'support_reply',
            version: '3',
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: 'Be concise.' },
              { role: 'user', content: 'Reply to {{customer.name}} about {{topic}}.' },
            ],
            parameters: { temperature: 0.2, max_tokens: 60 },
          },
        ],
      }),
    );
    process.env.AGNT5_ENVIRONMENT = 'production';
    process.env.AGNT5_PROMPTS_MANIFEST = join(tempDir, 'prompts.lock');

    const request: GenerateRequest = {
      model: 'openai/gpt-4o-mini',
      promptRef: 'support_reply',
    };
    const promptRef: PromptRef = {
      id: 'support_reply',
      variables: { customer: { name: 'Ada' } as any, topic: 'shipping' },
    };

    const resolved = resolvePromptRefFromManifest(request, promptRef);

    expect(resolved?.model).toBe('openai/gpt-4o-mini');
    expect(resolved?.promptRef).toBeUndefined();
    expect(resolved?.config?.temperature).toBe(0.2);
    expect(resolved?.config?.maxOutputTokens).toBe(60);
    expect(resolved?.messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Reply to Ada about shipping.' },
    ]);
  });
});
