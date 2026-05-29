use futures_util::StreamExt;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use napi_derive::napi;
use serde_json::Value;
use std::env;

use agnt5_sdk_core::error::Result as SdkResult;
use agnt5_sdk_core::lm::{
    AnthropicConfig,
    AnthropicProvider,
    AzureOpenAiConfig,
    AzureOpenAiProvider,
    BedrockConfig,
    BedrockProvider,
    BuiltInTool,
    DeepSeekConfig,
    // Additional providers
    DeepSeekProvider,
    GenerateRequest,
    GenerateResponse,
    GenerationConfig,
    GoogleConfig,
    GoogleProvider,
    GroqConfig,
    GroqProvider,
    HuggingFaceConfig,
    HuggingFaceProvider,
    JsonSchemaFormat,
    LanguageModel as LMTrait,
    Message,
    MessageRole,
    MistralConfig,
    MistralProvider,
    Modality,
    OllamaConfig,
    OllamaProvider,
    OpenAiChatConfig,
    OpenAiChatProvider,
    OpenAiConfig,
    OpenAiProvider,
    OpenRouterConfig,
    OpenRouterProvider,
    PromptRef,
    ReasoningEffort,
    ResponseFormat,
    StreamChunk,
    StreamHandle,
    TokenUsage,
    ToolChoice,
    ToolDefinition,
    XaiConfig,
    XaiProvider,
};

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
    DeepSeek(DeepSeekProvider),
    Google(GoogleProvider),
    Mistral(MistralProvider),
    Ollama(OllamaProvider),
    Xai(XaiProvider),
    HuggingFace(HuggingFaceProvider),
    OpenAiChat(OpenAiChatProvider),
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
            ProviderKind::DeepSeek(provider) => provider.generate(request).await,
            ProviderKind::Google(provider) => provider.generate(request).await,
            ProviderKind::Mistral(provider) => provider.generate(request).await,
            ProviderKind::Ollama(provider) => provider.generate(request).await,
            ProviderKind::Xai(provider) => provider.generate(request).await,
            ProviderKind::HuggingFace(provider) => provider.generate(request).await,
            ProviderKind::OpenAiChat(provider) => provider.generate(request).await,
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
            ProviderKind::DeepSeek(provider) => provider.stream(request).await,
            ProviderKind::Google(provider) => provider.stream(request).await,
            ProviderKind::Mistral(provider) => provider.stream(request).await,
            ProviderKind::Ollama(provider) => provider.stream(request).await,
            ProviderKind::Xai(provider) => provider.stream(request).await,
            ProviderKind::HuggingFace(provider) => provider.stream(request).await,
            ProviderKind::OpenAiChat(provider) => provider.stream(request).await,
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
        let parameters =
            if let Some(params_str) = tool.parameters {
                Some(serde_json::from_str::<Value>(&params_str).map_err(|e| {
                    Error::from_reason(format!("Invalid tool parameters JSON: {}", e))
                })?)
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
#[allow(dead_code)]
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
#[allow(dead_code)]
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
                let name = format.schema_name.ok_or_else(|| {
                    Error::from_reason("schema_name required for json_schema format")
                })?;
                let schema_str = format
                    .schema
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
    WebFetch,
}

impl From<JsBuiltInTool> for BuiltInTool {
    fn from(tool: JsBuiltInTool) -> Self {
        match tool {
            JsBuiltInTool::WebSearch => BuiltInTool::WebSearch,
            JsBuiltInTool::CodeInterpreter => BuiltInTool::CodeInterpreter,
            JsBuiltInTool::FileSearch => BuiltInTool::FileSearch,
            JsBuiltInTool::WebFetch => BuiltInTool::WebFetch,
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

        let reasoning_effort = config.reasoning_effort.map(|effort| match effort.as_str() {
            "minimal" => ReasoningEffort::Minimal,
            "medium" => ReasoningEffort::Medium,
            "high" => ReasoningEffort::High,
            _ => ReasoningEffort::Medium,
        });

        let modalities = config.modalities.map(|mods| {
            mods.iter()
                .filter_map(|m| match m.as_str() {
                    "text" => Some(Modality::Text),
                    "audio" => Some(Modality::Audio),
                    "image" => Some(Modality::Image),
                    _ => None,
                })
                .collect()
        });

        let built_in_tools = config
            .built_in_tools
            .map(|tools| {
                tools
                    .iter()
                    .filter_map(|t| BuiltInTool::from_provider_name(t.as_str()))
                    .collect()
            })
            .unwrap_or_default();

        Ok(GenerationConfig {
            temperature: config.temperature.map(|t| t as f32),
            top_p: config.top_p.map(|p| p as f32),
            max_output_tokens: config.max_output_tokens,
            response_format,
            reasoning_effort,
            modalities,
            built_in_tools,
            timeout: None,
        })
    }
}

// ============================================================================
// Request/Response Types
// ============================================================================

#[napi(object)]
pub struct JsGenerateRequest {
    pub model: String,
    pub prompt_ref: Option<JsPromptRef>,
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
            js_tools
                .into_iter()
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
            prompt_ref: req.prompt_ref.map(|p| p.into()),
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
pub struct JsPromptRef {
    pub id: String,
    pub version: Option<String>,
    pub environment_id: Option<String>,
    pub environment_ref: Option<String>,
    pub variables: Option<String>,
}

impl From<JsPromptRef> for PromptRef {
    fn from(value: JsPromptRef) -> Self {
        let variables = value
            .variables
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|parsed| parsed.as_object().cloned())
            .unwrap_or_default();
        Self {
            id: value.id,
            version: value.version,
            environment_id: value.environment_id,
            environment_ref: value.environment_ref,
            variables,
        }
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
            calls
                .into_iter()
                .map(|call| JsToolCall {
                    id: call.id,
                    name: call.name,
                    arguments: call.arguments,
                })
                .collect()
        });

        let raw = resp
            .raw
            .map(|value| serde_json::to_string(&value).ok())
            .flatten();

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
        let api_key = config
            .api_key
            .or_else(|| env::var("OPENAI_API_KEY").ok())
            .unwrap_or_else(|| "".to_string());

        let mut cfg = OpenAiConfig::new(api_key);

        if let Some(org) = config
            .organization_id
            .or_else(|| env::var("OPENAI_ORG_ID").ok())
        {
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
        let api_key = config
            .api_key
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
        let api_key = config
            .api_key
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
        let api_key = config
            .api_key
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
        let api_key = config
            .api_key
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
// Additional Provider Configs
// ============================================================================

#[napi(object)]
pub struct JsDeepSeekConfig {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
}

impl From<JsDeepSeekConfig> for DeepSeekConfig {
    fn from(config: JsDeepSeekConfig) -> Self {
        let api_key = config
            .api_key
            .or_else(|| env::var("DEEPSEEK_API_KEY").ok())
            .unwrap_or_else(|| "".to_string());

        let mut cfg = DeepSeekConfig::new(api_key);

        if let Some(url) = config.base_url {
            cfg = cfg.with_base_url(url);
        }

        cfg
    }
}

#[napi(object)]
pub struct JsGoogleConfig {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
}

impl From<JsGoogleConfig> for GoogleConfig {
    fn from(config: JsGoogleConfig) -> Self {
        let api_key = config
            .api_key
            .or_else(|| env::var("GOOGLE_API_KEY").ok())
            .or_else(|| env::var("GEMINI_API_KEY").ok())
            .unwrap_or_else(|| "".to_string());

        let mut cfg = GoogleConfig::new(api_key);

        if let Some(url) = config.base_url {
            cfg = cfg.with_base_url(url);
        }

        cfg
    }
}

#[napi(object)]
pub struct JsMistralConfig {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
}

impl From<JsMistralConfig> for MistralConfig {
    fn from(config: JsMistralConfig) -> Self {
        let api_key = config
            .api_key
            .or_else(|| env::var("MISTRAL_API_KEY").ok())
            .unwrap_or_else(|| "".to_string());

        let mut cfg = MistralConfig::new(api_key);

        if let Some(url) = config.base_url {
            cfg = cfg.with_base_url(url);
        }

        cfg
    }
}

#[napi(object)]
pub struct JsOllamaConfig {
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

impl From<JsOllamaConfig> for OllamaConfig {
    fn from(config: JsOllamaConfig) -> Self {
        let mut cfg = OllamaConfig::new();

        if let Some(url) = config
            .base_url
            .or_else(|| env::var("OLLAMA_BASE_URL").ok())
            .or_else(|| env::var("OLLAMA_HOST").ok())
        {
            cfg = cfg.with_base_url(url);
        }

        if let Some(key) = config.api_key.or_else(|| env::var("OLLAMA_API_KEY").ok()) {
            cfg = cfg.with_api_key(key);
        }

        cfg
    }
}

#[napi(object)]
pub struct JsXaiConfig {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
}

impl From<JsXaiConfig> for XaiConfig {
    fn from(config: JsXaiConfig) -> Self {
        let api_key = config
            .api_key
            .or_else(|| env::var("XAI_API_KEY").ok())
            .unwrap_or_else(|| "".to_string());

        let mut cfg = XaiConfig::new(api_key);

        if let Some(url) = config.base_url {
            cfg = cfg.with_base_url(url);
        }

        cfg
    }
}

#[napi(object)]
pub struct JsHuggingFaceConfig {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
}

impl From<JsHuggingFaceConfig> for HuggingFaceConfig {
    fn from(config: JsHuggingFaceConfig) -> Self {
        let api_key = config
            .api_key
            .or_else(|| env::var("HUGGINGFACE_API_KEY").ok())
            .or_else(|| env::var("HF_TOKEN").ok())
            .unwrap_or_else(|| "".to_string());

        let mut cfg = HuggingFaceConfig::new(api_key);

        if let Some(url) = config.base_url {
            cfg = cfg.with_base_url(url);
        }

        cfg
    }
}

#[napi(object)]
pub struct JsOpenAiChatConfig {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub organization: Option<String>,
}

impl From<JsOpenAiChatConfig> for OpenAiChatConfig {
    fn from(config: JsOpenAiChatConfig) -> Self {
        let api_key = config
            .api_key
            .or_else(|| env::var("OPENAI_API_KEY").ok())
            .unwrap_or_else(|| "".to_string());

        let mut cfg = OpenAiChatConfig::new(api_key);

        if let Some(url) = config.base_url {
            cfg = cfg.with_base_url(url);
        }

        if let Some(org) = config.organization {
            cfg = cfg.with_organization(org);
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
        let provider = AnthropicProvider::new(cfg).map_err(|e| {
            Error::from_reason(format!("Failed to create Anthropic provider: {}", e))
        })?;
        Ok(Self {
            provider: ProviderKind::Anthropic(provider),
        })
    }

    /// Create Azure OpenAI provider
    #[napi(factory)]
    pub fn azure(config: JsAzureOpenAiConfig) -> Result<Self> {
        let cfg: AzureOpenAiConfig = config.into();
        let provider = AzureOpenAiProvider::new(cfg).map_err(|e| {
            Error::from_reason(format!("Failed to create Azure OpenAI provider: {}", e))
        })?;
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
        let provider = OpenRouterProvider::new(cfg).map_err(|e| {
            Error::from_reason(format!("Failed to create OpenRouter provider: {}", e))
        })?;
        Ok(Self {
            provider: ProviderKind::OpenRouter(provider),
        })
    }

    /// Create DeepSeek provider
    #[napi(factory)]
    pub fn deepseek(config: Option<JsDeepSeekConfig>) -> Result<Self> {
        let cfg: DeepSeekConfig = config.map(|c| c.into()).unwrap_or_else(|| {
            let api_key = env::var("DEEPSEEK_API_KEY").unwrap_or_else(|_| "".to_string());
            DeepSeekConfig::new(api_key)
        });
        let provider = DeepSeekProvider::new(cfg).map_err(|e| {
            Error::from_reason(format!("Failed to create DeepSeek provider: {}", e))
        })?;
        Ok(Self {
            provider: ProviderKind::DeepSeek(provider),
        })
    }

    /// Create Google (Gemini) provider
    #[napi(factory)]
    pub fn google(config: Option<JsGoogleConfig>) -> Result<Self> {
        let cfg: GoogleConfig = config.map(|c| c.into()).unwrap_or_else(|| {
            let api_key = env::var("GOOGLE_API_KEY")
                .or_else(|_| env::var("GEMINI_API_KEY"))
                .unwrap_or_else(|_| "".to_string());
            GoogleConfig::new(api_key)
        });
        let provider = GoogleProvider::new(cfg)
            .map_err(|e| Error::from_reason(format!("Failed to create Google provider: {}", e)))?;
        Ok(Self {
            provider: ProviderKind::Google(provider),
        })
    }

    /// Create Mistral provider
    #[napi(factory)]
    pub fn mistral(config: Option<JsMistralConfig>) -> Result<Self> {
        let cfg: MistralConfig = config.map(|c| c.into()).unwrap_or_else(|| {
            let api_key = env::var("MISTRAL_API_KEY").unwrap_or_else(|_| "".to_string());
            MistralConfig::new(api_key)
        });
        let provider = MistralProvider::new(cfg)
            .map_err(|e| Error::from_reason(format!("Failed to create Mistral provider: {}", e)))?;
        Ok(Self {
            provider: ProviderKind::Mistral(provider),
        })
    }

    /// Create Ollama provider (local LLM)
    #[napi(factory)]
    pub fn ollama(config: Option<JsOllamaConfig>) -> Result<Self> {
        let cfg: OllamaConfig = config.map(|c| c.into()).unwrap_or_else(OllamaConfig::new);
        let provider = OllamaProvider::new(cfg)
            .map_err(|e| Error::from_reason(format!("Failed to create Ollama provider: {}", e)))?;
        Ok(Self {
            provider: ProviderKind::Ollama(provider),
        })
    }

    /// Create xAI (Grok) provider
    #[napi(factory)]
    pub fn xai(config: Option<JsXaiConfig>) -> Result<Self> {
        let cfg: XaiConfig = config.map(|c| c.into()).unwrap_or_else(|| {
            let api_key = env::var("XAI_API_KEY").unwrap_or_else(|_| "".to_string());
            XaiConfig::new(api_key)
        });
        let provider = XaiProvider::new(cfg)
            .map_err(|e| Error::from_reason(format!("Failed to create xAI provider: {}", e)))?;
        Ok(Self {
            provider: ProviderKind::Xai(provider),
        })
    }

    /// Create HuggingFace provider
    #[napi(factory)]
    pub fn huggingface(config: Option<JsHuggingFaceConfig>) -> Result<Self> {
        let cfg: HuggingFaceConfig = config.map(|c| c.into()).unwrap_or_else(|| {
            let api_key = env::var("HUGGINGFACE_API_KEY")
                .or_else(|_| env::var("HF_TOKEN"))
                .unwrap_or_else(|_| "".to_string());
            HuggingFaceConfig::new(api_key)
        });
        let provider = HuggingFaceProvider::new(cfg).map_err(|e| {
            Error::from_reason(format!("Failed to create HuggingFace provider: {}", e))
        })?;
        Ok(Self {
            provider: ProviderKind::HuggingFace(provider),
        })
    }

    /// Create OpenAI Chat-compatible provider (for custom OpenAI-compatible APIs)
    #[napi(factory)]
    pub fn openai_chat(config: Option<JsOpenAiChatConfig>) -> Result<Self> {
        let cfg: OpenAiChatConfig = config.map(|c| c.into()).unwrap_or_else(|| {
            let api_key = env::var("OPENAI_API_KEY").unwrap_or_else(|_| "".to_string());
            OpenAiChatConfig::new(api_key)
        });
        let provider = OpenAiChatProvider::new(cfg).map_err(|e| {
            Error::from_reason(format!("Failed to create OpenAI Chat provider: {}", e))
        })?;
        Ok(Self {
            provider: ProviderKind::OpenAiChat(provider),
        })
    }

    /// Generate a completion
    #[napi]
    pub async fn generate(&self, request: JsGenerateRequest) -> Result<JsGenerateResponse> {
        let req: GenerateRequest = request.try_into()?;
        let response = self
            .provider
            .generate(req)
            .await
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
        let mut stream_handle = self
            .provider
            .stream(req)
            .await
            .map_err(|e| Error::from_reason(format!("Stream failed: {}", e)))?;

        while let Some(chunk_result) = stream_handle.next().await {
            match chunk_result {
                Ok(StreamChunk::Delta { content, .. }) => {
                    let js_chunk = JsStreamChunk {
                        chunk_type: "delta".to_string(),
                        content: Some(content),
                        response: None,
                    };
                    let status = callback.call(
                        js_chunk,
                        napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
                    );
                    if status != napi::Status::Ok {
                        return Err(Error::from_reason(format!(
                            "Stream callback failed with status: {status:?}"
                        )));
                    }
                }
                Ok(StreamChunk::Completed(response)) => {
                    let js_chunk = JsStreamChunk {
                        chunk_type: "completed".to_string(),
                        content: None,
                        response: Some(response.into()),
                    };
                    let status = callback.call(
                        js_chunk,
                        napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
                    );
                    if status != napi::Status::Ok {
                        return Err(Error::from_reason(format!(
                            "Stream callback failed with status: {status:?}"
                        )));
                    }
                    break;
                }
                Ok(StreamChunk::ContentBlockStart { .. })
                | Ok(StreamChunk::ContentBlockStop { .. }) => {
                    // Content block markers — skip for now
                    continue;
                }
                Err(e) => {
                    return Err(Error::from_reason(format!("Stream failed: {}", e)));
                }
            }
        }

        Ok(())
    }
}
