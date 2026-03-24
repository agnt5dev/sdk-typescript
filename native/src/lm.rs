use napi::bindgen_prelude::*;
use napi_derive::napi;
use napi::threadsafe_function::{ThreadsafeFunction, ErrorStrategy};
use std::env;
use futures_util::StreamExt;
use serde_json::Value;

use agnt5_sdk_core::lm::{
    AnthropicProvider, AzureOpenAiProvider, BedrockProvider, GenerateRequest, GenerateResponse,
    GenerationConfig, GroqProvider, JsonSchemaFormat, Message, MessageRole, OpenAiProvider,
    OpenRouterProvider, ResponseFormat, StreamChunk, StreamHandle, TokenUsage,
    ToolChoice, ToolDefinition, ReasoningEffort, Modality, BuiltInTool,
    AnthropicConfig, AzureOpenAiConfig, BedrockConfig, GroqConfig, OpenAiConfig, OpenRouterConfig,
};
use agnt5_sdk_core::error::Result as SdkResult;

// ============================================================================
// Provider Enum
// ============================================================================

#[derive(Clone)]
enum ProviderKind {
    OpenAi(OpenAiProvider),
    Azure(AzureOpenAiProvider),
    Bedrock(BedrockProvider),
    Anthropic(AnthropicProvider),
    Groq(GroqProvider),
    OpenRouter(OpenRouterProvider),
}

impl ProviderKind {
    async fn generate(&self, request: GenerateRequest) -> SdkResult<GenerateResponse> {
        match self {
            ProviderKind::OpenAi(provider) => provider.generate(request).await,
            ProviderKind::Azure(provider) => provider.generate(request).await,
            ProviderKind::Bedrock(provider) => provider.generate(request).await,
            ProviderKind::Anthropic(provider) => provider.generate(request).await,
            ProviderKind::Groq(provider) => provider.generate(request).await,
            ProviderKind::OpenRouter(provider) => provider.generate(request).await,
        }
    }

    async fn stream(&self, request: GenerateRequest) -> SdkResult<StreamHandle> {
        match self {
            ProviderKind::OpenAi(provider) => provider.stream(request).await,
            ProviderKind::Azure(provider) => provider.stream(request).await,
            ProviderKind::Bedrock(provider) => provider.stream(request).await,
            ProviderKind::Anthropic(provider) => provider.stream(request).await,
            ProviderKind::Groq(provider) => provider.stream(request).await,
            ProviderKind::OpenRouter(provider) => provider.stream(request).await,
        }
    }
}

// ============================================================================
// Message Types
// ============================================================================

#[napi(string_enum)]
pub enum JsMessageRole {
    System,
    User,
    Assistant,
}

impl From<JsMessageRole> for MessageRole {
    fn from(role: JsMessageRole) -> Self {
        match role {
            JsMessageRole::System => MessageRole::System,
            JsMessageRole::User => MessageRole::User,
            JsMessageRole::Assistant => MessageRole::Assistant,
        }
    }
}

impl From<MessageRole> for JsMessageRole {
    fn from(role: MessageRole) -> Self {
        match role {
            MessageRole::System => JsMessageRole::System,
            MessageRole::User => JsMessageRole::User,
            MessageRole::Assistant => JsMessageRole::Assistant,
        }
    }
}

#[napi(object)]
pub struct JsMessage {
    pub role: String,
    pub content: String,
}

impl From<JsMessage> for Message {
    fn from(msg: JsMessage) -> Self {
        let role = match msg.role.as_str() {
            "system" => MessageRole::System,
            "user" => MessageRole::User,
            "assistant" => MessageRole::Assistant,
            _ => MessageRole::User,
        };
        Message::new(role, msg.content)
    }
}

impl From<Message> for JsMessage {
    fn from(msg: Message) -> Self {
        JsMessage {
            role: msg.role.as_str().to_string(),
            content: msg.content,
        }
    }
}

// ============================================================================
// Tool Types
// ============================================================================

#[napi(object)]
pub struct JsToolDefinition {
    pub name: String,
    pub description: Option<String>,
    pub parameters: Option<String>, // JSON string
    pub strict: Option<bool>,
}

impl TryFrom<JsToolDefinition> for ToolDefinition {
    type Error = Error;

    fn try_from(tool: JsToolDefinition) -> Result<Self> {
        let parameters = if let Some(params_str) = tool.parameters {
            Some(serde_json::from_str::<Value>(&params_str)
                .map_err(|e| Error::from_reason(format!("Invalid tool parameters JSON: {}", e)))?)
        } else {
            None
        };

        Ok(ToolDefinition {
            name: tool.name,
            description: tool.description,
            parameters,
            strict: tool.strict,
        })
    }
}

#[napi(string_enum)]
pub enum JsToolChoice {
    Auto,
    None,
    Tool,
}

#[napi(object)]
pub struct JsToolChoiceOption {
    pub choice_type: String,
    pub tool_name: Option<String>,
}

impl From<JsToolChoiceOption> for ToolChoice {
    fn from(choice: JsToolChoiceOption) -> Self {
        match choice.choice_type.as_str() {
            "auto" => ToolChoice::Auto,
            "none" => ToolChoice::None,
            "tool" => {
                if let Some(name) = choice.tool_name {
                    ToolChoice::Tool { name }
                } else {
                    ToolChoice::Auto
                }
            }
            _ => ToolChoice::Auto,
        }
    }
}

#[napi(object)]
pub struct JsToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

// ============================================================================
// Generation Config Types
// ============================================================================

#[napi(string_enum)]
pub enum JsResponseFormat {
    Text,
    Json,
    JsonSchema,
}

#[napi(object)]
pub struct JsResponseFormatOption {
    pub format_type: String,
    pub schema_name: Option<String>,
    pub schema: Option<String>, // JSON string
    pub strict: Option<bool>,
}

impl TryFrom<JsResponseFormatOption> for ResponseFormat {
    type Error = Error;

    fn try_from(format: JsResponseFormatOption) -> Result<Self> {
        match format.format_type.as_str() {
            "text" => Ok(ResponseFormat::Text),
            "json" => Ok(ResponseFormat::Json),
            "json_schema" => {
                let name = format.schema_name
                    .ok_or_else(|| Error::from_reason("schema_name required for json_schema format"))?;
                let schema_str = format.schema
                    .ok_or_else(|| Error::from_reason("schema required for json_schema format"))?;
                let schema = serde_json::from_str::<Value>(&schema_str)
                    .map_err(|e| Error::from_reason(format!("Invalid schema JSON: {}", e)))?;

                Ok(ResponseFormat::JsonSchema(JsonSchemaFormat {
                    name,
                    schema,
                    strict: format.strict.unwrap_or(true),
                }))
            }
            _ => Ok(ResponseFormat::Text),
        }
    }
}

#[napi(string_enum)]
pub enum JsReasoningEffort {
    Minimal,
    Medium,
    High,
}

impl From<JsReasoningEffort> for ReasoningEffort {
    fn from(effort: JsReasoningEffort) -> Self {
        match effort {
            JsReasoningEffort::Minimal => ReasoningEffort::Minimal,
            JsReasoningEffort::Medium => ReasoningEffort::Medium,
            JsReasoningEffort::High => ReasoningEffort::High,
        }
    }
}

#[napi(string_enum)]
pub enum JsModality {
    Text,
    Audio,
    Image,
}

impl From<JsModality> for Modality {
    fn from(modality: JsModality) -> Self {
        match modality {
            JsModality::Text => Modality::Text,
            JsModality::Audio => Modality::Audio,
            JsModality::Image => Modality::Image,
        }
    }
}

#[napi(string_enum)]
pub enum JsBuiltInTool {
    WebSearch,
    CodeInterpreter,
    FileSearch,
}

impl From<JsBuiltInTool> for BuiltInTool {
    fn from(tool: JsBuiltInTool) -> Self {
        match tool {
            JsBuiltInTool::WebSearch => BuiltInTool::WebSearch,
            JsBuiltInTool::CodeInterpreter => BuiltInTool::CodeInterpreter,
            JsBuiltInTool::FileSearch => BuiltInTool::FileSearch,
        }
    }
}

#[napi(object)]
pub struct JsGenerationConfig {
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_output_tokens: Option<u32>,
    pub response_format: Option<JsResponseFormatOption>,
    pub reasoning_effort: Option<String>,
    pub modalities: Option<Vec<String>>,
    pub built_in_tools: Option<Vec<String>>,
}

impl TryFrom<JsGenerationConfig> for GenerationConfig {
    type Error = Error;

    fn try_from(config: JsGenerationConfig) -> Result<Self> {
        let response_format = if let Some(format) = config.response_format {
            format.try_into()?
        } else {
            ResponseFormat::default()
        };

        let reasoning_effort = config.reasoning_effort.map(|effort| {
            match effort.as_str() {
                "minimal" => ReasoningEffort::Minimal,
                "medium" => ReasoningEffort::Medium,
                "high" => ReasoningEffort::High,
                _ => ReasoningEffort::Medium,
            }
        });

        let modalities = config.modalities.map(|mods| {
            mods.iter().filter_map(|m| {
                match m.as_str() {
                    "text" => Some(Modality::Text),
                    "audio" => Some(Modality::Audio),
                    "image" => Some(Modality::Image),
                    _ => None,
                }
            }).collect()
        });

        let built_in_tools = config.built_in_tools.map(|tools| {
            tools.iter().filter_map(|t| {
                match t.as_str() {
                    "web_search" => Some(BuiltInTool::WebSearch),
                    "code_interpreter" => Some(BuiltInTool::CodeInterpreter),
                    "file_search" => Some(BuiltInTool::FileSearch),
                    _ => None,
                }
            }).collect()
        }).unwrap_or_default();

        Ok(GenerationConfig {
            temperature: config.temperature.map(|t| t as f32),
            top_p: config.top_p.map(|p| p as f32),
            max_output_tokens: config.max_output_tokens,
            response_format,
            reasoning_effort,
            modalities,
            built_in_tools,
        })
    }
}

// ============================================================================
// Request/Response Types
// ============================================================================

#[napi(object)]
pub struct JsGenerateRequest {
    pub model: String,
    pub system_prompt: Option<String>,
    pub messages: Vec<JsMessage>,
    pub tools: Option<Vec<JsToolDefinition>>,
    pub tool_choice: Option<JsToolChoiceOption>,
    pub user_id: Option<String>,
    pub config: Option<JsGenerationConfig>,
}

impl TryFrom<JsGenerateRequest> for GenerateRequest {
    type Error = Error;

    fn try_from(req: JsGenerateRequest) -> Result<Self> {
        let messages: Vec<Message> = req.messages.into_iter().map(|m| m.into()).collect();

        let tools: Vec<ToolDefinition> = if let Some(js_tools) = req.tools {
            js_tools.into_iter()
                .map(|t| t.try_into())
                .collect::<Result<Vec<_>>>()?
        } else {
            Vec::new()
        };

        let tool_choice = req.tool_choice.map(|tc| tc.into());

        let config = if let Some(cfg) = req.config {
            cfg.try_into()?
        } else {
            GenerationConfig::default()
        };

        Ok(GenerateRequest {
            model: req.model,
            system_prompt: req.system_prompt,
            messages,
            tools,
            tool_choice,
            user_id: req.user_id,
            config,
            previous_response_id: None,
            otel_context: None,
        })
    }
}

#[napi(object)]
pub struct JsTokenUsage {
    pub prompt_tokens: Option<u32>,
    pub completion_tokens: Option<u32>,
    pub total_tokens: Option<u32>,
}

impl From<TokenUsage> for JsTokenUsage {
    fn from(usage: TokenUsage) -> Self {
        JsTokenUsage {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
        }
    }
}

#[napi(object)]
pub struct JsGenerateResponse {
    pub id: String,
    pub model: String,
    pub created: Option<f64>,
    pub text: String,
    pub usage: Option<JsTokenUsage>,
    pub finish_reason: Option<String>,
    pub tool_calls: Option<Vec<JsToolCall>>,
    pub raw: Option<String>, // JSON string
}

impl From<GenerateResponse> for JsGenerateResponse {
    fn from(resp: GenerateResponse) -> Self {
        let tool_calls = resp.tool_calls.map(|calls| {
            calls.into_iter().map(|call| JsToolCall {
                id: call.id,
                name: call.name,
                arguments: call.arguments,
            }).collect()
        });

        let raw = resp.raw.map(|value| serde_json::to_string(&value).ok()).flatten();

        JsGenerateResponse {
            id: resp.id,
            model: resp.model,
            created: resp.created.map(|c| c as f64),
            text: resp.text,
            usage: resp.usage.map(|u| u.into()),
            finish_reason: resp.finish_reason,
            tool_calls,
            raw,
        }
    }
}

#[napi(object)]
pub struct JsStreamChunk {
    pub chunk_type: String, // "delta" or "completed"
    pub content: Option<String>,
    pub response: Option<JsGenerateResponse>,
}

// ============================================================================
// Provider Configurations
// ============================================================================

#[napi(object)]
pub struct JsOpenAiConfig {
    pub api_key: Option<String>,
    pub organization_id: Option<String>,
    pub base_url: Option<String>,
}

impl From<JsOpenAiConfig> for OpenAiConfig {
    fn from(config: JsOpenAiConfig) -> Self {
        let api_key = config.api_key
            .or_else(|| env::var("OPENAI_API_KEY").ok())
            .unwrap_or_else(|| "".to_string());

        let mut cfg = OpenAiConfig::new(api_key);

        if let Some(org) = config.organization_id.or_else(|| env::var("OPENAI_ORG_ID").ok()) {
            cfg.organization = Some(org);
        }

        if let Some(url) = config.base_url {
            cfg.base_url = url;
        }

        cfg
    }
}

#[napi(object)]
pub struct JsAnthropicConfig {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
}

impl From<JsAnthropicConfig> for AnthropicConfig {
    fn from(config: JsAnthropicConfig) -> Self {
        let api_key = config.api_key
            .or_else(|| env::var("ANTHROPIC_API_KEY").ok())
            .unwrap_or_else(|| "".to_string());

        let mut cfg = AnthropicConfig::new(api_key);

        if let Some(url) = config.base_url {
            cfg = cfg.with_base_url(url);
        }

        cfg
    }
}

#[napi(object)]
pub struct JsAzureOpenAiConfig {
    pub api_key: Option<String>,
    pub endpoint: String,
    pub api_version: Option<String>,
}

impl From<JsAzureOpenAiConfig> for AzureOpenAiConfig {
    fn from(config: JsAzureOpenAiConfig) -> Self {
        let api_key = config.api_key
            .or_else(|| env::var("AZURE_OPENAI_API_KEY").ok())
            .unwrap_or_else(|| "".to_string());

        let mut cfg = AzureOpenAiConfig::new(api_key, config.endpoint);

        if let Some(version) = config.api_version {
            cfg = cfg.with_api_version(version);
        }

        cfg
    }
}

#[napi(object)]
pub struct JsBedrockConfig {
    pub region: Option<String>,
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
    pub session_token: Option<String>,
}

impl TryFrom<JsBedrockConfig> for BedrockConfig {
    type Error = Error;

    fn try_from(config: JsBedrockConfig) -> Result<Self> {
        // Set env vars temporarily if provided
        if let Some(key_id) = &config.access_key_id {
            env::set_var("AWS_ACCESS_KEY_ID", key_id);
        }
        if let Some(secret) = &config.secret_access_key {
            env::set_var("AWS_SECRET_ACCESS_KEY", secret);
        }
        if let Some(token) = &config.session_token {
            env::set_var("AWS_SESSION_TOKEN", token);
        }
        if let Some(region) = &config.region {
            env::set_var("AWS_REGION", region);
        }

        // Use from_env which properly constructs the credentials
        BedrockConfig::from_env()
            .map_err(|e| Error::from_reason(format!("Failed to create Bedrock config: {}", e)))
    }
}

#[napi(object)]
pub struct JsGroqConfig {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
}

impl From<JsGroqConfig> for GroqConfig {
    fn from(config: JsGroqConfig) -> Self {
        let api_key = config.api_key
            .or_else(|| env::var("GROQ_API_KEY").ok())
            .unwrap_or_else(|| "".to_string());

        let mut cfg = GroqConfig::new(api_key);

        if let Some(url) = config.base_url {
            cfg = cfg.with_base_url(url);
        }

        cfg
    }
}

#[napi(object)]
pub struct JsOpenRouterConfig {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
}

impl From<JsOpenRouterConfig> for OpenRouterConfig {
    fn from(config: JsOpenRouterConfig) -> Self {
        let api_key = config.api_key
            .or_else(|| env::var("OPENROUTER_API_KEY").ok())
            .unwrap_or_else(|| "".to_string());

        let mut cfg = OpenRouterConfig::new(api_key);

        if let Some(url) = config.base_url {
            cfg = cfg.with_base_url(url);
        }

        cfg
    }
}

// ============================================================================
// Language Model Client
// ============================================================================

#[napi]
pub struct LanguageModel {
    provider: ProviderKind,
}

#[napi]
impl LanguageModel {
    /// Create OpenAI provider
    #[napi(factory)]
    pub fn openai(config: Option<JsOpenAiConfig>) -> Result<Self> {
        let cfg: OpenAiConfig = config.map(|c| c.into()).unwrap_or_else(|| {
            let api_key = env::var("OPENAI_API_KEY").unwrap_or_else(|_| "".to_string());
            OpenAiConfig::new(api_key)
        });
        let provider = OpenAiProvider::new(cfg)
            .map_err(|e| Error::from_reason(format!("Failed to create OpenAI provider: {}", e)))?;
        Ok(Self {
            provider: ProviderKind::OpenAi(provider),
        })
    }

    /// Create Anthropic provider
    #[napi(factory)]
    pub fn anthropic(config: Option<JsAnthropicConfig>) -> Result<Self> {
        let cfg: AnthropicConfig = config.map(|c| c.into()).unwrap_or_else(|| {
            let api_key = env::var("ANTHROPIC_API_KEY").unwrap_or_else(|_| "".to_string());
            AnthropicConfig::new(api_key)
        });
        let provider = AnthropicProvider::new(cfg)
            .map_err(|e| Error::from_reason(format!("Failed to create Anthropic provider: {}", e)))?;
        Ok(Self {
            provider: ProviderKind::Anthropic(provider),
        })
    }

    /// Create Azure OpenAI provider
    #[napi(factory)]
    pub fn azure(config: JsAzureOpenAiConfig) -> Result<Self> {
        let cfg: AzureOpenAiConfig = config.into();
        let provider = AzureOpenAiProvider::new(cfg)
            .map_err(|e| Error::from_reason(format!("Failed to create Azure OpenAI provider: {}", e)))?;
        Ok(Self {
            provider: ProviderKind::Azure(provider),
        })
    }

    /// Create AWS Bedrock provider
    #[napi(factory)]
    pub fn bedrock(config: JsBedrockConfig) -> Result<Self> {
        let cfg: BedrockConfig = config.try_into()?;
        let provider = BedrockProvider::new(cfg)
            .map_err(|e| Error::from_reason(format!("Failed to create Bedrock provider: {}", e)))?;
        Ok(Self {
            provider: ProviderKind::Bedrock(provider),
        })
    }

    /// Create Groq provider
    #[napi(factory)]
    pub fn groq(config: Option<JsGroqConfig>) -> Result<Self> {
        let cfg: GroqConfig = config.map(|c| c.into()).unwrap_or_else(|| {
            let api_key = env::var("GROQ_API_KEY").unwrap_or_else(|_| "".to_string());
            GroqConfig::new(api_key)
        });
        let provider = GroqProvider::new(cfg)
            .map_err(|e| Error::from_reason(format!("Failed to create Groq provider: {}", e)))?;
        Ok(Self {
            provider: ProviderKind::Groq(provider),
        })
    }

    /// Create OpenRouter provider
    #[napi(factory)]
    pub fn openrouter(config: Option<JsOpenRouterConfig>) -> Result<Self> {
        let cfg: OpenRouterConfig = config.map(|c| c.into()).unwrap_or_else(|| {
            let api_key = env::var("OPENROUTER_API_KEY").unwrap_or_else(|_| "".to_string());
            OpenRouterConfig::new(api_key)
        });
        let provider = OpenRouterProvider::new(cfg)
            .map_err(|e| Error::from_reason(format!("Failed to create OpenRouter provider: {}", e)))?;
        Ok(Self {
            provider: ProviderKind::OpenRouter(provider),
        })
    }

    /// Generate a completion
    #[napi]
    pub async fn generate(&self, request: JsGenerateRequest) -> Result<JsGenerateResponse> {
        let req: GenerateRequest = request.try_into()?;
        let response = self.provider.generate(req).await
            .map_err(|e| Error::from_reason(format!("Generate failed: {}", e)))?;
        Ok(response.into())
    }

    /// Stream a completion
    #[napi]
    pub async fn stream(
        &self,
        request: JsGenerateRequest,
        callback: ThreadsafeFunction<JsStreamChunk, ErrorStrategy::Fatal>,
    ) -> Result<()> {
        let req: GenerateRequest = request.try_into()?;
        let mut stream_handle = self.provider.stream(req).await
            .map_err(|e| Error::from_reason(format!("Stream failed: {}", e)))?;

        // Spawn task to process stream
        tokio::spawn(async move {
            while let Some(chunk_result) = stream_handle.next().await {
                match chunk_result {
                    Ok(StreamChunk::Delta { content, .. }) => {
                        let js_chunk = JsStreamChunk {
                            chunk_type: "delta".to_string(),
                            content: Some(content),
                            response: None,
                        };
                        let status = callback.call(js_chunk, napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking);
                        if status != napi::Status::Ok {
                            break;
                        }
                    }
                    Ok(StreamChunk::Completed(response)) => {
                        let js_chunk = JsStreamChunk {
                            chunk_type: "completed".to_string(),
                            content: None,
                            response: Some(response.into()),
                        };
                        let _ = callback.call(js_chunk, napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking);
                        break;
                    }
                    Ok(StreamChunk::ContentBlockStart { .. }) |
                    Ok(StreamChunk::ContentBlockStop { .. }) => {
                        // Content block markers — skip for now
                        continue;
                    }
                    Err(e) => {
                        eprintln!("Stream error: {}", e);
                        break;
                    }
                }
            }
        });

        Ok(())
    }
}
