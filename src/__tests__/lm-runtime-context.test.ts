import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LM } from '../lm.js';
import { runWithContext } from '../async-context.js';

const generate = vi.fn(async (request: any) => ({
  id: 'response-1',
  model: request.model,
  text: 'ok',
}));

vi.mock('../native-loader.js', () => ({
  loadNativeBindings: () => ({
    LanguageModel: {
      openai: vi.fn(() => ({ generate })),
      anthropic: vi.fn(() => ({ generate })),
    },
  }),
}));

describe('LM runtime context overrides', () => {
  it('applies runtime LLM overrides to generation requests', async () => {
    generate.mockClear();
    const lm = LM.openai();

    await runWithContext(
      {
        runId: 'run-1',
        runtime: {
          llm: {
            model: 'openai/gpt-4o',
            temperature: 0.7,
            maxOutputTokens: 88,
            topP: 0.6,
          },
          prompts: {},
        },
      },
      async () => {
        await lm.generate({
          model: 'openai/gpt-4o-mini',
          messages: [{ role: 'user', content: 'hello' }],
          config: { temperature: 0.1, maxOutputTokens: 20 },
        });
      },
    );

    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0][0]).toMatchObject({
      model: 'openai/gpt-4o',
      config: {
        temperature: 0.7,
        maxOutputTokens: 88,
        topP: 0.6,
      },
    });
  });

  it('applies prompt-specific runtime LLM overrides before the global default', async () => {
    generate.mockClear();
    const lm = LM.openai();
    const originalEnv = { ...process.env };
    const tempDir = mkdtempSync(join(tmpdir(), 'agnt5-prompts-'));
    mkdirSync(join(tempDir, 'prompts'));
    for (const promptId of ['classify', 'draft', 'review']) {
      writeFileSync(
        join(tempDir, 'prompts', `${promptId}.mdx`),
        `---
id: ${promptId}
model: openai/gpt-4o-mini
---

<User>
Run ${promptId}.
</User>
`,
      );
    }
    process.env.AGNT5_ENVIRONMENT = 'production';
    process.env.AGNT5_PROMPTS_MANIFEST = tempDir;

    try {
      await runWithContext(
        {
          runId: 'run-1',
          runtime: {
            llm: {
              model: 'openai/gpt-4o-mini',
              temperature: 0.2,
            },
            prompts: {
              draft: {
                model: 'openai/gpt-4o',
                temperature: 0.8,
              },
              review: {
                model: 'openai/gpt-4.1',
                temperature: 0.3,
              },
            },
          },
        },
        async () => {
          await lm.generate({ model: 'openai/gpt-4o-mini', prompt: { id: 'classify' } });
          await lm.generate({ model: 'openai/gpt-4o-mini', prompt: { id: 'draft' } });
          await lm.generate({ model: 'openai/gpt-4o-mini', prompt: { id: 'review' } });
        },
      );
    } finally {
      process.env = originalEnv;
      rmSync(tempDir, { recursive: true, force: true });
    }

    expect(generate).toHaveBeenCalledTimes(3);
    expect(generate.mock.calls.map(([request]) => request.model)).toEqual([
      'openai/gpt-4o-mini',
      'openai/gpt-4o',
      'openai/gpt-4.1',
    ]);
    expect(generate.mock.calls.map(([request]) => request.config.temperature)).toEqual([
      0.2,
      0.8,
      0.3,
    ]);
  });
});
