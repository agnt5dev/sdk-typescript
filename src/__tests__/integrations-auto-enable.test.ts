import { afterEach, expect, it, vi } from 'vitest';

const attach = vi.hoisted(() => ({
  openai: vi.fn(async () => true),
  agents: vi.fn(async () => false),
  vercel: vi.fn(async () => true),
  adk: vi.fn(async () => false),
}));

vi.mock('../integrations/openai.js', () => ({ enableOpenAICapture: attach.openai }));
vi.mock('../integrations/openai-agents.js', () => ({ enableOpenAIAgentsCapture: attach.agents }));
vi.mock('../integrations/vercel-ai.js', () => ({ enableVercelAICapture: attach.vercel }));
vi.mock('../integrations/google-adk.js', () => ({
  enableGoogleADKCapture: attach.adk,
  createGoogleADKCapturePlugin: vi.fn(),
}));

afterEach(() => {
  delete process.env.AGNT5_DEBUG;
});

it('says which integrations attached, so capture can be checked with AGNT5_DEBUG', async () => {
  process.env.AGNT5_DEBUG = '1';
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  const { autoEnable } = await import('../integrations/index.js');

  await autoEnable();

  const lines = debug.mock.calls.map((call) => String(call[0]));
  expect(lines).toContain('[agnt5 capture] OpenAI SDK capture attached');
  expect(lines).toContain('[agnt5 capture] Vercel AI SDK capture attached');
  expect(lines.some((line) => line.includes('Google ADK capture attached'))).toBe(false);
  expect(lines.some((line) => line.includes('OpenAI Agents SDK capture attached'))).toBe(false);
  debug.mockRestore();
});
