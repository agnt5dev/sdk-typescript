use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;

use agnt5_sdk_core::chat;

// ============================================================================
// Platform enum
// ============================================================================

#[napi(string_enum)]
pub enum JsPlatform {
    Slack,
    Discord,
    Teams,
    Telegram,
}

impl From<JsPlatform> for chat::Platform {
    fn from(p: JsPlatform) -> Self {
        match p {
            JsPlatform::Slack => chat::Platform::Slack,
            JsPlatform::Discord => chat::Platform::Discord,
            JsPlatform::Teams => chat::Platform::Teams,
            JsPlatform::Telegram => chat::Platform::Telegram,
        }
    }
}

impl From<chat::Platform> for JsPlatform {
    fn from(p: chat::Platform) -> Self {
        match p {
            chat::Platform::Slack => JsPlatform::Slack,
            chat::Platform::Discord => JsPlatform::Discord,
            chat::Platform::Teams => JsPlatform::Teams,
            chat::Platform::Telegram => JsPlatform::Telegram,
        }
    }
}

// ============================================================================
// Data types (JS objects)
// ============================================================================

#[napi(object)]
pub struct JsChatUser {
    pub id: String,
    pub name: String,
    pub platform: String,
}

impl From<&chat::ChatUser> for JsChatUser {
    fn from(u: &chat::ChatUser) -> Self {
        Self {
            id: u.id.clone(),
            name: u.name.clone(),
            platform: u.platform.to_string(),
        }
    }
}

#[napi(object)]
pub struct JsAttachment {
    pub filename: String,
    pub mime_type: Option<String>,
    pub url: Option<String>,
    pub size_bytes: Option<f64>, // JS doesn't have u64
}

impl From<&chat::Attachment> for JsAttachment {
    fn from(a: &chat::Attachment) -> Self {
        Self {
            filename: a.filename.clone(),
            mime_type: a.mime_type.clone(),
            url: a.url.clone(),
            size_bytes: a.size_bytes.map(|s| s as f64),
        }
    }
}

#[napi(object)]
pub struct JsChatMessage {
    pub id: String,
    pub platform: String,
    pub channel_id: String,
    pub thread_id: Option<String>,
    pub author: JsChatUser,
    pub content: String,
    pub attachments: Vec<JsAttachment>,
    pub is_mention: bool,
    pub is_dm: bool,
    pub metadata: HashMap<String, String>,
}

impl From<&chat::ChatMessage> for JsChatMessage {
    fn from(m: &chat::ChatMessage) -> Self {
        Self {
            id: m.id.clone(),
            platform: m.platform.to_string(),
            channel_id: m.channel_id.clone(),
            thread_id: m.thread_id.clone(),
            author: JsChatUser::from(&m.author),
            content: m.content.clone(),
            attachments: m.attachments.iter().map(JsAttachment::from).collect(),
            is_mention: m.is_mention,
            is_dm: m.is_dm,
            metadata: m.metadata.clone(),
        }
    }
}

#[napi(object)]
pub struct JsChatEvent {
    /// Event type: "message", "mention", "reaction", "slash_command", "action", "url_verification"
    pub event_type: String,
    /// The message (for message/mention events).
    pub message: Option<JsChatMessage>,
    /// Channel ID (if applicable).
    pub channel_id: Option<String>,
    /// Thread ID (if applicable).
    pub thread_id: Option<String>,
    /// User who triggered the event.
    pub user: Option<JsChatUser>,
    /// Challenge string (url_verification only).
    pub challenge: Option<String>,
    /// Emoji name (reaction only).
    pub emoji: Option<String>,
    /// Command name (slash_command only).
    pub command: Option<String>,
    /// Command arguments (slash_command only).
    pub args: Option<String>,
    /// Action ID (action only).
    pub action_id: Option<String>,
}

impl From<&chat::ChatEvent> for JsChatEvent {
    fn from(e: &chat::ChatEvent) -> Self {
        let event_type = match e {
            chat::ChatEvent::Message(_) => "message",
            chat::ChatEvent::Mention(_) => "mention",
            chat::ChatEvent::Reaction { .. } => "reaction",
            chat::ChatEvent::SlashCommand { .. } => "slash_command",
            chat::ChatEvent::Action { .. } => "action",
            chat::ChatEvent::UrlVerification { .. } => "url_verification",
        };

        let message = match e {
            chat::ChatEvent::Message(m) | chat::ChatEvent::Mention(m) => {
                Some(JsChatMessage::from(m))
            }
            _ => None,
        };

        let challenge = match e {
            chat::ChatEvent::UrlVerification { challenge } => Some(challenge.clone()),
            _ => None,
        };

        let emoji = match e {
            chat::ChatEvent::Reaction { emoji, .. } => Some(emoji.clone()),
            _ => None,
        };

        let (command, args) = match e {
            chat::ChatEvent::SlashCommand { command, args, .. } => {
                (Some(command.clone()), Some(args.clone()))
            }
            _ => (None, None),
        };

        let action_id = match e {
            chat::ChatEvent::Action { action_id, .. } => Some(action_id.clone()),
            _ => None,
        };

        Self {
            event_type: event_type.to_string(),
            message,
            channel_id: e.channel_id().map(|s| s.to_string()),
            thread_id: e.thread_id().map(|s| s.to_string()),
            user: e.user().map(JsChatUser::from),
            challenge,
            emoji,
            command,
            args,
            action_id,
        }
    }
}

#[napi(object)]
pub struct JsPlatformRequest {
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: Buffer,
}

impl From<chat::PlatformRequest> for JsPlatformRequest {
    fn from(r: chat::PlatformRequest) -> Self {
        Self {
            url: r.url,
            method: r.method,
            headers: r.headers,
            body: Buffer::from(r.body),
        }
    }
}

// ============================================================================
// StreamingMessageBuffer
// ============================================================================

#[napi]
pub struct StreamingMessageBuffer {
    inner: chat::StreamingMessageBuffer,
}

#[napi]
impl StreamingMessageBuffer {
    #[napi(constructor)]
    pub fn new(flush_interval_ms: Option<f64>) -> Self {
        let ms = flush_interval_ms.unwrap_or(500.0) as u64;
        Self {
            inner: chat::StreamingMessageBuffer::new(ms),
        }
    }

    /// Push a new token into the buffer.
    #[napi]
    pub fn push(&mut self, token: String) {
        self.inner.push(&token);
    }

    /// Check whether enough time has passed to flush.
    #[napi]
    pub fn should_flush(&self) -> bool {
        self.inner.should_flush()
    }

    /// Flush the buffer, returning markdown-healed content (or null if no new content).
    #[napi]
    pub fn flush(&mut self) -> Option<String> {
        self.inner.flush()
    }

    /// Finalize the buffer, returning complete raw content.
    #[napi]
    pub fn finalize(&mut self) -> String {
        self.inner.finalize()
    }

    /// Current accumulated content length.
    #[napi(getter)]
    pub fn length(&self) -> u32 {
        self.inner.len() as u32
    }

    /// Check if buffer is empty.
    #[napi(getter)]
    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }
}

// ============================================================================
// Free functions
// ============================================================================

/// Verify a webhook signature for the given platform.
#[napi]
pub fn verify_webhook(
    platform: JsPlatform,
    secret: String,
    headers: HashMap<String, String>,
    body: Buffer,
) -> Result<bool> {
    let p: chat::Platform = platform.into();
    chat::verify_webhook(&p, &secret, &headers, &body)
        .map_err(|e| Error::from_reason(e.to_string()))
}

/// Parse a raw webhook body into a normalized ChatEvent.
#[napi]
pub fn parse_event(platform: JsPlatform, body: Buffer) -> Result<JsChatEvent> {
    let p: chat::Platform = platform.into();
    let event = chat::parse_event(&p, &body)
        .map_err(|e| Error::from_reason(e.to_string()))?;
    Ok(JsChatEvent::from(&event))
}

/// Build a Slack chat.postMessage request.
#[napi]
pub fn slack_post_message(
    token: String,
    channel: String,
    text: String,
    thread_ts: Option<String>,
) -> JsPlatformRequest {
    chat::request_builder::slack_post_message(
        &token,
        &channel,
        &text,
        thread_ts.as_deref(),
    )
    .into()
}

/// Build a Slack chat.update request (for streaming post-then-edit).
#[napi]
pub fn slack_update_message(
    token: String,
    channel: String,
    message_ts: String,
    text: String,
) -> JsPlatformRequest {
    chat::request_builder::slack_update_message(&token, &channel, &message_ts, &text).into()
}

/// Build a Slack chat.postEphemeral request.
#[napi]
pub fn slack_post_ephemeral(
    token: String,
    channel: String,
    user: String,
    text: String,
    thread_ts: Option<String>,
) -> JsPlatformRequest {
    chat::request_builder::slack_post_ephemeral(
        &token,
        &channel,
        &user,
        &text,
        thread_ts.as_deref(),
    )
    .into()
}

/// Build a Slack reactions.add request.
#[napi]
pub fn slack_add_reaction(
    token: String,
    channel: String,
    message_ts: String,
    emoji: String,
) -> JsPlatformRequest {
    chat::request_builder::slack_add_reaction(&token, &channel, &message_ts, &emoji).into()
}
