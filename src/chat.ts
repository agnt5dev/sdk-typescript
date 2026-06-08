/**
 * AGNT5 Chat SDK — connect agents to Slack, Discord, Teams, and Telegram.
 *
 * The ChatBot class wraps an Agent and bridges it to chat platforms via
 * Rust core bindings for webhook verification, event parsing, and
 * platform API request construction.
 */

import type { Agent, AgentResult } from './agent.js';
import { ContextImpl } from './context.js';
import { createHash } from 'crypto';

// Native bindings (napi-rs)
let native: any;
try {
  native = require('../native/index.js');
} catch {
  // Native bindings not available — will throw at runtime if chat is used
  native = null;
}

// ============================================================================
// Platform configs
// ============================================================================

export interface SlackConfig {
  platform: 'slack';
  botToken: string;
  signingSecret: string;
  appToken?: string;
}

export interface DiscordConfig {
  platform: 'discord';
  botToken: string;
  publicKey: string;
  applicationId: string;
}

export interface TeamsConfig {
  platform: 'teams';
  appId: string;
  appPassword: string;
  tenantId?: string;
}

export interface TelegramConfig {
  platform: 'telegram';
  botToken: string;
  webhookSecret?: string;
}

export type PlatformConfig = SlackConfig | DiscordConfig | TeamsConfig | TelegramConfig;

// ============================================================================
// Types (mirrors native JsChatEvent, JsChatMessage, etc.)
// ============================================================================

export interface ChatUser {
  id: string;
  name: string;
  platform: string;
}

export interface Attachment {
  filename: string;
  mimeType?: string;
  url?: string;
  sizeBytes?: number;
}

export interface ChatMessage {
  id: string;
  platform: string;
  channelId: string;
  threadId?: string;
  author: ChatUser;
  content: string;
  attachments: Attachment[];
  isMention: boolean;
  isDm: boolean;
  metadata: Record<string, string>;
}

export interface ChatEvent {
  eventType: string;
  message?: ChatMessage;
  channelId?: string;
  threadId?: string;
  user?: ChatUser;
  challenge?: string;
  emoji?: string;
  command?: string;
  args?: string;
  actionId?: string;
}

export interface PlatformRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer;
}

export type ChatEventHandler = (event: ChatEvent) => Promise<string | null>;

// ============================================================================
// ChatBot
// ============================================================================

/**
 * Connects an AGNT5 Agent to chat platforms.
 *
 * ```typescript
 * import { Agent, Worker } from '@agnt5/sdk';
 * import { ChatBot, SlackConfig } from '@agnt5/sdk/chat';
 *
 * const agent = new Agent({
 *   name: 'support-bot',
 *   model: 'anthropic/claude-sonnet-4-20250514',
 *   instructions: 'You are a helpful support agent.',
 * });
 *
 * const bot = new ChatBot(agent, [
 *   { platform: 'slack', botToken: process.env.SLACK_BOT_TOKEN!, signingSecret: process.env.SLACK_SIGNING_SECRET! },
 * ]);
 *
 * const worker = new Worker({ serviceName: 'support-bot' });
 * worker.register(bot);
 * await worker.run();
 * ```
 */
export class ChatBot {
  private agent: Agent;
  private adapters: Map<string, PlatformConfig>;
  private handlers: Map<string, ChatEventHandler> = new Map();

  constructor(agent: Agent, adapters: PlatformConfig[]) {
    if (!native) {
      throw new Error('Native bindings not available. Chat SDK requires the native addon.');
    }
    this.agent = agent;
    this.adapters = new Map(adapters.map(a => [a.platform, a]));
  }

  /** Component name (delegates to the wrapped agent). */
  get name(): string {
    return this.agent.name;
  }

  // -- Handler registration --------------------------------------------------

  onMention(handler: ChatEventHandler): this {
    this.handlers.set('mention', handler);
    return this;
  }

  onMessage(handler: ChatEventHandler): this {
    this.handlers.set('message', handler);
    return this;
  }

  onReaction(handler: ChatEventHandler): this {
    this.handlers.set('reaction', handler);
    return this;
  }

  onAction(handler: ChatEventHandler): this {
    this.handlers.set('action', handler);
    return this;
  }

  onSlashCommand(handler: ChatEventHandler): this {
    this.handlers.set('slash_command', handler);
    return this;
  }

  // -- Webhook handling ------------------------------------------------------

  /**
   * Process an incoming webhook from a chat platform.
   * Returns a challenge response for URL verification, or null for normal events.
   */
  async handleWebhook(
    platform: string,
    headers: Record<string, string>,
    body: Buffer,
    botToken?: string,
  ): Promise<{ challenge: string } | null> {
    const config = this.adapters.get(platform);
    if (!config) {
      throw new Error(`No adapter configured for platform: ${platform}`);
    }

    // Map platform string to native enum
    const nativePlatform = this.toNativePlatform(platform);

    // Signature verified at the gateway (ADR-009 D5) — no SDK re-verify.
    const rawEvent = native.parseEvent(nativePlatform, body);
    const event = this.normalizeEvent(rawEvent);

    // url_verification is answered at the gateway; keep a defensive echo.
    if (event.eventType === 'url_verification' && event.challenge) {
      return { challenge: event.challenge };
    }

    // Route to handler
    const handler = this.handlers.get(event.eventType) ?? this.defaultHandler.bind(this);
    const responseText = await handler(event);

    if (responseText === null || responseText === undefined) {
      return null;
    }

    // Send response back to platform
    await this.sendResponse(config, event, responseText, botToken);
    return null;
  }

  /**
   * Process an inbound chat event with a streaming agent response (post-then-edit).
   */
  async handleWebhookStreaming(
    platform: string,
    headers: Record<string, string>,
    body: Buffer,
    botToken?: string,
  ): Promise<{ challenge: string } | null> {
    const config = this.adapters.get(platform);
    if (!config) {
      throw new Error(`No adapter configured for platform: ${platform}`);
    }

    const nativePlatform = this.toNativePlatform(platform);

    // Signature verified at the gateway (ADR-009 D5) — no SDK re-verify.
    const rawEvent = native.parseEvent(nativePlatform, body);
    const event = this.normalizeEvent(rawEvent);

    if (event.eventType === 'url_verification' && event.challenge) {
      return { challenge: event.challenge };
    }

    if (!event.message) {
      return null;
    }

    const msg = event.message;
    const threadTs = msg.threadId || msg.id;

    // Reply with the gateway-provided token, falling back to config.
    const slackConfig = config as SlackConfig;
    const token = botToken || slackConfig.botToken;

    // Post initial "thinking" message
    const initialReq = native.slackPostMessage(
      token, msg.channelId, 'Thinking...', threadTs,
    );
    const initialResp = await this.executeRequest(initialReq);
    const respData = await initialResp.json() as Record<string, any>;
    const messageTs = respData.ts || '';

    // Stream agent response with buffer
    const buffer = new native.StreamingMessageBuffer(500);

    for await (const agentEvent of this.agent.stream(msg.content)) {
      const delta = (agentEvent as any).delta;
      if (delta === undefined || delta === null) continue;

      buffer.push(delta);

      if (buffer.shouldFlush()) {
        const content = buffer.flush();
        if (content !== null && content !== undefined) {
          const updateReq = native.slackUpdateMessage(
            token, msg.channelId, messageTs, content,
          );
          await this.executeRequest(updateReq);
        }
      }
    }

    // Final update with complete content
    const finalContent = buffer.finalize();
    if (finalContent) {
      const finalReq = native.slackUpdateMessage(
        token, msg.channelId, messageTs, finalContent,
      );
      await this.executeRequest(finalReq);
    }

    return null;
  }

  // -- Internal helpers ------------------------------------------------------

  private async defaultHandler(event: ChatEvent): Promise<string | null> {
    if (!event.message) return null;

    const msg = event.message;

    // Derive session_id from thread context:
    // - If in a thread, use threadId (all replies share the same session)
    // - If a top-level message, use the message id (starts a new session)
    const threadKey = msg.threadId || msg.id;
    const sessionId = this.threadToSession(msg.platform, msg.channelId, threadKey);

    const ctx = new ContextImpl(
      sessionId,    // invocationId
      sessionId,    // runId — same thread = same session
      0,            // attempt
      this.agent.name,
    );

    const result: AgentResult = await this.agent.run(msg.content, ctx);
    return result.output != null ? String(result.output) : null;
  }

  /**
   * Derive a deterministic session ID from a platform thread.
   * Implements UUID v5 (RFC 4122) — identical to Python's uuid.uuid5().
   */
  private threadToSession(platform: string, channelId: string, threadId: string): string {
    // Namespace UUID for AGNT5 chat sessions (matches Python SDK)
    const ns = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const name = `${platform}:${channelId}:${threadId}`;

    // UUID v5: SHA-1(namespace_bytes + name_bytes), then set version & variant bits
    const nsBytes = Buffer.from(ns.replace(/-/g, ''), 'hex');
    const hash = createHash('sha1').update(Buffer.concat([nsBytes, Buffer.from(name)])).digest();

    // Set version to 5
    hash[6] = (hash[6] & 0x0f) | 0x50;
    // Set variant to RFC 4122
    hash[8] = (hash[8] & 0x3f) | 0x80;

    const hex = hash.subarray(0, 16).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  private async sendResponse(
    config: PlatformConfig,
    event: ChatEvent,
    text: string,
    botToken?: string,
  ): Promise<void> {
    if (config.platform === 'slack') {
      const slackConfig = config as SlackConfig;
      const threadTs = event.message?.threadId || event.message?.id || undefined;
      const req = native.slackPostMessage(
        botToken || slackConfig.botToken,
        event.channelId!,
        text,
        threadTs,
      );
      await this.executeRequest(req);
    } else {
      throw new Error(`Platform ${config.platform} not yet supported`);
    }
  }

  private async executeRequest(req: PlatformRequest): Promise<Response> {
    const response = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    if (!response.ok) {
      console.warn(
        `Platform API error: ${req.method} ${req.url} -> ${response.status} ${await response.text().catch(() => '')}`,
      );
    }
    return response;
  }

  private toNativePlatform(platform: string): string {
    // native.JsPlatform expects capitalized enum values
    return platform.charAt(0).toUpperCase() + platform.slice(1);
  }

  /**
   * Normalize the native JsChatEvent (snake_case keys) to our TS ChatEvent (camelCase).
   */
  private normalizeEvent(raw: any): ChatEvent {
    const msg = raw.message
      ? {
          id: raw.message.id,
          platform: raw.message.platform,
          channelId: raw.message.channel_id ?? raw.message.channelId,
          threadId: raw.message.thread_id ?? raw.message.threadId,
          author: raw.message.author,
          content: raw.message.content,
          attachments: (raw.message.attachments || []).map((a: any) => ({
            filename: a.filename,
            mimeType: a.mime_type ?? a.mimeType,
            url: a.url,
            sizeBytes: a.size_bytes ?? a.sizeBytes,
          })),
          isMention: raw.message.is_mention ?? raw.message.isMention,
          isDm: raw.message.is_dm ?? raw.message.isDm,
          metadata: raw.message.metadata || {},
        }
      : undefined;

    return {
      eventType: raw.event_type ?? raw.eventType,
      message: msg,
      channelId: raw.channel_id ?? raw.channelId,
      threadId: raw.thread_id ?? raw.threadId,
      user: raw.user,
      challenge: raw.challenge,
      emoji: raw.emoji,
      command: raw.command,
      args: raw.args,
      actionId: raw.action_id ?? raw.actionId,
    };
  }
}
