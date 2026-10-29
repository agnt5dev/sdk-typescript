import { debugLog, libraryCaptureEnabled, masterCaptureEnabled } from './_common.js';
import { enableGoogleADKCapture } from './google-adk.js';
import { enableOpenAIAgentsCapture } from './openai-agents.js';
import { enableOpenAICapture } from './openai.js';
import { enableVercelAICapture } from './vercel-ai.js';

export { enableGoogleADKCapture, createGoogleADKCapturePlugin } from './google-adk.js';
export { enableOpenAIAgentsCapture } from './openai-agents.js';
export { enableOpenAICapture } from './openai.js';
export {
  enableVercelAICapture,
  JournalSpanProcessor,
  journalTelemetry,
  wrapAISDK,
} from './vercel-ai.js';

let autoEnabled = false;

/** Enable every installed integration allowed by the environment gates. */
export async function autoEnable(): Promise<void> {
  if (autoEnabled) return;
  autoEnabled = true;
  if (!masterCaptureEnabled()) {
    debugLog('capture disabled via AGNT5_CAPTURE');
    return;
  }

  const integrations: Array<[string, string, () => Promise<boolean>]> = [
    ['AGNT5_CAPTURE_OPENAI', 'OpenAI SDK', enableOpenAICapture],
    ['AGNT5_CAPTURE_OPENAI_AGENTS', 'OpenAI Agents SDK', enableOpenAIAgentsCapture],
    ['AGNT5_CAPTURE_VERCEL_AI', 'Vercel AI SDK', enableVercelAICapture],
    ['AGNT5_CAPTURE_GOOGLE_ADK', 'Google ADK', enableGoogleADKCapture],
  ];
  await Promise.all(integrations.map(async ([flag, library, enable]) => {
    if (!libraryCaptureEnabled(flag)) {
      debugLog(`capture disabled via ${flag}`);
      return;
    }
    try {
      // One line per library, so "is capture on?" can be answered with
      // AGNT5_DEBUG=1 instead of by reading the source.
      if (await enable()) debugLog(`${library} capture attached`);
    } catch (error) {
      debugLog(`capture auto-enable failed for ${flag}`, error);
    }
  }));
}
