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

  const integrations: Array<[string, () => Promise<boolean>]> = [
    ['AGNT5_CAPTURE_OPENAI', enableOpenAICapture],
    ['AGNT5_CAPTURE_OPENAI_AGENTS', enableOpenAIAgentsCapture],
    ['AGNT5_CAPTURE_VERCEL_AI', enableVercelAICapture],
    ['AGNT5_CAPTURE_GOOGLE_ADK', enableGoogleADKCapture],
  ];
  await Promise.all(integrations.map(async ([flag, enable]) => {
    if (!libraryCaptureEnabled(flag)) {
      debugLog(`capture disabled via ${flag}`);
      return;
    }
    try {
      await enable();
    } catch (error) {
      debugLog(`capture auto-enable failed for ${flag}`, error);
    }
  }));
}
