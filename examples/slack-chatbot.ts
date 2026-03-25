/**
 * Example: Slack ChatBot
 *
 * Demonstrates connecting an AGNT5 Agent to Slack:
 * - Creating a ChatBot with a Slack adapter
 * - Default behavior: agent processes every mention automatically
 * - Custom handlers: override behavior for mentions, messages, reactions
 * - Thread continuity: same Slack thread = same AGNT5 session
 *
 * Setup:
 * 1. Create a Slack app at https://api.slack.com/apps
 * 2. Enable Events API, subscribe to: app_mention, message.im
 * 3. Add bot scopes: chat:write, app_mentions:read, im:history
 * 4. Set the webhook URL to: https://<gateway>/v1/chat/webhooks/slack/<bot-name>
 * 5. Set environment variables:
 *    - SLACK_BOT_TOKEN: xoxb-... token from OAuth & Permissions
 *    - SLACK_SIGNING_SECRET: from Basic Information > App Credentials
 *    - OPENAI_API_KEY or ANTHROPIC_API_KEY: for the agent's LLM
 *
 * Run:
 *    npx tsx slack-chatbot.ts
 */

import { Agent, Worker } from '../src/index.js';
import { ChatBot } from '../src/chat.js';
import type { SlackConfig, ChatEvent } from '../src/chat.js';

// =============================================================================
// BASIC CHATBOT — Agent handles all mentions automatically
// =============================================================================

const supportAgent = new Agent({
  name: 'support-bot',
  model: 'anthropic/claude-sonnet-4-20250514',
  instructions:
    'You are a helpful support agent in Slack. ' +
    'Keep responses concise and use Slack-compatible markdown. ' +
    "If you don't know the answer, say so honestly.",
  temperature: 0.3,
  maxIterations: 5,
});

// Wrap the agent in a ChatBot with Slack credentials
const bot = new ChatBot(supportAgent, [
  {
    platform: 'slack' as const,
    botToken: process.env.SLACK_BOT_TOKEN || 'xoxb-placeholder',
    signingSecret: process.env.SLACK_SIGNING_SECRET || 'placeholder',
  } satisfies SlackConfig,
]);

// =============================================================================
// CUSTOM HANDLERS (optional) — override default agent behavior
// =============================================================================

// Uncomment any of these to customize how the bot responds to specific events.

// bot.onMention(async (event: ChatEvent) => {
//   const user = event.user?.name || 'someone';
//   const msg = event.message?.content || '';
//   return `Hey ${user}! You said: ${msg}`;
// });

// bot.onReaction(async (event: ChatEvent) => {
//   if (event.emoji === 'flag-es') {
//     return '¡Hola! Detected a Spanish flag reaction.';
//   }
//   return null; // Return null to skip sending a response
// });

// bot.onSlashCommand(async (event: ChatEvent) => {
//   if (event.command === '/support-status') {
//     return 'All systems operational.';
//   }
//   return null;
// });

// =============================================================================
// REGISTER AND RUN
// =============================================================================

const worker = new Worker({ serviceName: 'support-bot' });
worker.registerAgents([bot as any]);
await worker.run();
