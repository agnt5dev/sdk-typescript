use napi::bindgen_prelude::*;
use napi_derive::napi;
use napi::threadsafe_function::{
    ThreadsafeFunction, ErrorStrategy, ThreadsafeFunctionCallMode,
};

use agnt5_sdk_core::worker::{Worker as CoreWorker, WorkerConfig};
use agnt5_sdk_core::pb::{RuntimeMessage, ServiceMessage, ComponentInfo};
use agnt5_sdk_core::{JournalEventQueue, JournalEventMessage};

use std::sync::{Arc, Mutex as StdMutex};
use std::collections::HashMap;
use tokio::sync::Mutex as TokioMutex;

// For logging in Span implementation
extern crate log;

// Language model module
mod lm;

/// Worker configuration options
#[napi(object)]
pub struct WorkerOptions {
    /// Service name
    pub service_name: String,
    /// Service version
    pub service_version: Option<String>,
    /// Service type (function, workflow, agent, etc.)
    pub service_type: Option<String>,
    /// Coordinator endpoint URL
    pub coordinator_endpoint: Option<String>,
    /// Tenant ID (falls back to AGNT5_TENANT_ID env var)
    pub tenant_id: Option<String>,
    /// Deployment ID (falls back to AGNT5_DEPLOYMENT_ID env var)
    pub deployment_id: Option<String>,
}

/// Component type enum matching protobuf
#[napi(string_enum)]
pub enum ComponentType {
    Function,
    Flow,
    Object,
    Task,
    Workflow,
    Agent,
    Tool,
    Mcp,
    Entity,
    Scorer,
}

/// Component info for registration
#[napi(object)]
pub struct ComponentInfoData {
    pub name: String,
    pub component_type: String,
    pub config: Option<HashMap<String, String>>,
    pub metadata: Option<HashMap<String, String>>,
    pub definition: Option<String>,
}

impl From<ComponentInfoData> for ComponentInfo {
    fn from(data: ComponentInfoData) -> Self {
        use agnt5_sdk_core::pb::ComponentType as PbComponentType;

        // Parse component type from string (matches proto ComponentType enum)
        let component_type = match data.component_type.to_lowercase().as_str() {
            "function" => PbComponentType::Function as i32,
            "flow" => PbComponentType::Flow as i32,
            "object" => PbComponentType::Object as i32,
            "task" => PbComponentType::Task as i32,
            "workflow" => PbComponentType::Workflow as i32,
            "agent" => PbComponentType::Agent as i32,
            "tool" => PbComponentType::Tool as i32,
            "mcp" => PbComponentType::Mcp as i32,
            "entity" => PbComponentType::Entity as i32,
            "scorer" => PbComponentType::Scorer as i32,
            _ => PbComponentType::Function as i32, // default to function
        };

        ComponentInfo {
            name: data.name,
            component_type,
            input_schema: None,
            output_schema: None,
            config: data.config.unwrap_or_default(),
            metadata: data.metadata.unwrap_or_default(),
            definition: data.definition,
            max_attempts: None,
            initial_interval_ms: None,
            max_interval_ms: None,
            backoff_type: None,
            backoff_multiplier: None,
        }
    }
}

/// Runtime message data for TypeScript callbacks (simplified)
#[napi(object)]
pub struct RuntimeMessageData {
    /// Invocation ID
    pub invocation_id: String,
    /// Component name to execute
    pub component_name: String,
    /// Component type
    pub component_type: String,
    /// Input data as JSON string
    pub input_json: String,
    /// Request metadata
    pub metadata: HashMap<String, String>,
}

/// Service message response from TypeScript (simplified)
#[napi(object)]
pub struct ServiceMessageData {
    /// Invocation ID (must match request)
    pub invocation_id: String,
    /// Output data as JSON string
    pub output_json: Option<String>,
    /// Error message if execution failed
    pub error: Option<String>,
}

/// Worker for handling function invocations and platform connectivity
#[napi]
pub struct Worker {
    service_name: String,
    config: WorkerConfig,
    core_worker: Arc<TokioMutex<CoreWorker>>,
    /// Fire-and-forget callback to JS handler. The JS side calls resolveResponse() when done.
    message_handler: Arc<StdMutex<Option<ThreadsafeFunction<RuntimeMessageData, ErrorStrategy::Fatal>>>>,
    /// Response channel map: invocation_id → oneshot sender for the response JSON
    response_map: Arc<StdMutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>>,
    /// Journal event queue (Arc-backed, shared with core worker's flush task)
    journal_queue: JournalEventQueue,
    /// Cloned CoreWorker for emit_checkpoint. CoreWorker is Clone and all internal state
    /// is Arc-backed, so this clone shares the same EE client, journal queue, etc.
    /// Needed because run() holds core_worker's TokioMutex for its entire lifetime,
    /// which would deadlock if emit_checkpoint tried to acquire the same lock.
    emit_worker: Arc<StdMutex<Option<CoreWorker>>>,
}

#[napi]
impl Worker {
    /// Create a new worker instance
    #[napi(constructor)]
    pub fn new(options: WorkerOptions) -> Result<Self> {
        // Build worker config from options
        let mut config = WorkerConfig::new(
            options.service_name.clone(),
            options.service_version.unwrap_or_else(|| "0.1.0".to_string()),
            options.service_type.unwrap_or_else(|| "function".to_string()),
        );

        // Override coordinator endpoint if provided
        if let Some(endpoint) = options.coordinator_endpoint {
            config.coordinator_endpoint = endpoint;
        }

        // Build service metadata (tenant_id, deployment_id) for checkpoint emission.
        // emit_checkpoint_sync merges self.metadata into each checkpoint's metadata,
        // and the EE requires tenant_id to write to journal_events.
        let mut metadata = HashMap::new();
        if let Some(ref tid) = options.tenant_id {
            metadata.insert("tenant_id".to_string(), tid.clone());
        } else if let Ok(tid) = std::env::var("AGNT5_TENANT_ID") {
            metadata.insert("tenant_id".to_string(), tid);
        }
        if let Some(ref did) = options.deployment_id {
            metadata.insert("deployment_id".to_string(), did.clone());
        } else if let Ok(did) = std::env::var("AGNT5_DEPLOYMENT_ID") {
            metadata.insert("deployment_id".to_string(), did);
        }

        // Create core worker with empty components initially
        let core_worker = CoreWorker::new(
            config.clone(),
            vec![],
            metadata,
        );

        // Clone the journal queue (Arc-backed) for direct access from NAPI methods.
        // The core worker's run() will spawn a flush task that drains this same queue.
        let journal_queue = core_worker.journal_queue();

        // Clone the core worker for emit_checkpoint (Arc-backed, shares all internal state)
        let emit_worker = core_worker.clone();

        Ok(Worker {
            service_name: options.service_name,
            config,
            core_worker: Arc::new(TokioMutex::new(core_worker)),
            message_handler: Arc::new(StdMutex::new(None)),
            response_map: Arc::new(StdMutex::new(HashMap::new())),
            journal_queue,
            emit_worker: Arc::new(StdMutex::new(Some(emit_worker))),
        })
    }

    /// Get service name
    #[napi(getter)]
    pub fn service_name(&self) -> String {
        self.service_name.clone()
    }

    /// Get worker ID
    #[napi(getter)]
    pub fn worker_id(&self) -> String {
        self.config.worker_id.clone()
    }

    /// Get coordinator endpoint
    #[napi(getter)]
    pub fn coordinator_endpoint(&self) -> String {
        self.config.coordinator_endpoint.clone()
    }

    /// Get tenant ID from environment (no longer on WorkerConfig)
    #[napi(getter)]
    pub fn tenant_id(&self) -> String {
        std::env::var("AGNT5_TENANT_ID").unwrap_or_default()
    }

    /// Get deployment ID from environment (no longer on WorkerConfig)
    #[napi(getter)]
    pub fn deployment_id(&self) -> String {
        std::env::var("AGNT5_DEPLOYMENT_ID").unwrap_or_default()
    }

    /// Set the message handler callback.
    /// The JS callback should NOT return a value. Instead, call resolveResponse()
    /// with the invocation ID and JSON response when async processing completes.
    #[napi]
    pub fn set_message_handler(
        &self,
        #[napi(ts_arg_type = "(message: RuntimeMessageData) => void")]
        callback: JsFunction,
    ) -> Result<()> {
        let tsfn: ThreadsafeFunction<RuntimeMessageData, ErrorStrategy::Fatal> = callback
            .create_threadsafe_function(0, |ctx| {
                Ok(vec![ctx.value])
            })?;

        let mut handler = self.message_handler.lock()
            .map_err(|e| Error::from_reason(format!("Failed to lock message handler: {}", e)))?;
        *handler = Some(tsfn);

        Ok(())
    }

    /// Called by JS handler when async processing completes.
    /// Sends the response JSON back through the oneshot channel to the waiting Rust handler.
    #[napi]
    pub fn resolve_response(&self, invocation_id: String, response_json: String) -> Result<()> {
        let sender = {
            let mut map = self.response_map.lock()
                .map_err(|e| Error::from_reason(format!("Failed to lock response map: {}", e)))?;
            map.remove(&invocation_id)
        };
        if let Some(sender) = sender {
            let _ = sender.send(response_json);
        }
        Ok(())
    }

    /// Queue an SSE-only event (output.delta, log, progress, etc.) into the journal queue.
    /// The background flush task (spawned by run()) drains this queue every 50ms.
    #[napi]
    pub fn queue_event(
        &self,
        run_id: String,
        event_type: String,
        event_data: String,
        content_index: i32,
        sequence: i64,
        metadata: HashMap<String, String>,
        source_timestamp_ns: f64,
        correlation_id: String,
        parent_correlation_id: String,
    ) -> Result<()> {
        let is_sse_only = JournalEventMessage::is_sse_only_event_type(&event_type);
        let event = JournalEventMessage {
            run_id,
            event_type,
            data: event_data.into_bytes(),
            correlation_id,
            parent_correlation_id,
            tenant_id: Some(std::env::var("AGNT5_TENANT_ID").unwrap_or_default()),
            source_timestamp_ns: source_timestamp_ns as i64,
            metadata,
            queued_at: std::time::Instant::now(),
            is_streaming: true,
            is_sse_only,
            content_index,
            sequence,
        };
        self.journal_queue.push(event)
            .map_err(|e| Error::from_reason(format!("Failed to queue event: {}", e)))?;
        Ok(())
    }

    /// Emit a checkpoint event (run.started, function.completed, etc.) via direct gRPC
    /// to the Execution Engine. Blocks until acknowledged or timeout.
    ///
    /// Uses emit_worker (a Clone of CoreWorker) to avoid deadlocking with run(),
    /// which holds core_worker's TokioMutex for its entire lifetime.
    #[napi]
    pub async fn emit_checkpoint(
        &self,
        run_id: String,
        event_type: String,
        event_data: String,
        sequence_number: i64,
        metadata: HashMap<String, String>,
        source_timestamp_ns: f64,
        timeout_ms: Option<f64>,
    ) -> Result<()> {
        let worker = {
            let guard = self.emit_worker.lock()
                .map_err(|e| Error::from_reason(format!("Failed to lock emit_worker: {}", e)))?;
            guard.clone().ok_or_else(|| Error::from_reason("emit_worker not available"))?
        };
        worker.emit_checkpoint_sync(
            run_id,
            event_type,
            event_data.into_bytes(),
            sequence_number,
            metadata,
            source_timestamp_ns as i64,
            timeout_ms.unwrap_or(5000.0) as u64,
        ).await.map_err(|e| Error::from_reason(format!("Checkpoint emission failed: {}", e)))?;
        Ok(())
    }

    /// Set components for registration
    #[napi]
    pub async fn set_components(&self, components: Vec<ComponentInfoData>) -> Result<()> {
        let component_infos: Vec<ComponentInfo> = components
            .into_iter()
            .map(|c| c.into())
            .collect();

        // Update core worker's components
        let mut worker = self.core_worker.lock().await;
        worker.set_components(component_infos);

        Ok(())
    }

    /// Run the worker and connect to platform
    #[napi]
    pub async fn run(&self) -> Result<()> {
        // Verify message handler is set
        let handler = self.message_handler.lock()
            .map_err(|e| Error::from_reason(format!("Failed to lock message handler: {}", e)))?
            .clone()
            .ok_or_else(|| Error::from_reason("Message handler not set. Call set_message_handler() first."))?;

        // Shared response map for the handler closure
        let response_map = self.response_map.clone();

        // Create message handler that calls TypeScript callback
        let message_handler = move |runtime_msg: RuntimeMessage, _tx: flume::Sender<ServiceMessage>| {
            let handler_clone = handler.clone();
            let response_map = response_map.clone();

            async move {
                use agnt5_sdk_core::pb::{runtime_message, service_message, DispatchComponentResponse, dispatch_component_response};

                // Extract DispatchComponentRequest from RuntimeMessage.
                // Other message types (health checks, checkpoint acks, etc.) are
                // handled internally by the core worker — skip them here.
                let dispatch_request = match runtime_msg.message_data {
                    Some(runtime_message::MessageData::DispatchComponent(req)) => req,
                    _ => {
                        return Ok(None);
                    }
                };

                // Convert component type i32 to string (matches proto ComponentType enum values)
                let component_type_str = match dispatch_request.component_type {
                    1 => "function",
                    2 => "flow",
                    3 => "object",
                    4 => "task",
                    5 => "workflow",
                    6 => "agent",
                    7 => "tool",
                    8 => "mcp",
                    9 => "entity",
                    10 => "scorer",
                    _ => "unknown",
                }.to_string();

                // Convert input_data bytes to JSON string
                let input_json = String::from_utf8(dispatch_request.input_data.clone())
                    .unwrap_or_else(|_| "{}".to_string());

                let invocation_id = dispatch_request.invocation_id.clone();

                // Create simplified RuntimeMessageData for TypeScript
                let runtime_msg_data = RuntimeMessageData {
                    invocation_id: invocation_id.clone(),
                    component_name: dispatch_request.component_name.clone(),
                    component_type: component_type_str,
                    input_json,
                    metadata: dispatch_request.metadata.clone(),
                };

                // Set up response channel BEFORE firing the JS callback.
                // JS handler calls resolveResponse(invocationId, json) when done.
                let (tx, rx) = tokio::sync::oneshot::channel::<String>();
                {
                    let mut map = response_map.lock()
                        .map_err(|e| agnt5_sdk_core::error::SdkError::Internal(
                            format!("Failed to lock response map: {}", e)
                        ))?;
                    map.insert(invocation_id.clone(), tx);
                }

                // Fire-and-forget: send message to JS thread, don't wait for return value.
                // napi-rs ThreadsafeFunction can't properly handle async (Promise) returns,
                // so we use a separate channel (resolveResponse) for the result.
                handler_clone.call(runtime_msg_data, ThreadsafeFunctionCallMode::NonBlocking);

                // Wait for JS handler to call resolveResponse() (with 5 min timeout)
                let response_json = tokio::time::timeout(
                    std::time::Duration::from_secs(300),
                    rx,
                ).await
                    .map_err(|_| agnt5_sdk_core::error::SdkError::Internal(
                        format!("Handler response timeout for invocation {}", invocation_id)
                    ))?
                    .map_err(|_| agnt5_sdk_core::error::SdkError::Internal(
                        format!("Response channel dropped for invocation {}", invocation_id)
                    ))?;

                // Parse the JSON response
                let resp: serde_json::Value = serde_json::from_str(&response_json)
                    .map_err(|e| agnt5_sdk_core::error::SdkError::Internal(
                        format!("Failed to parse handler response: {}", e)
                    ))?;

                let invocation_id = resp["invocationId"].as_str().unwrap_or("").to_string();
                let error_msg = resp["error"].as_str().map(|s| s.to_string());
                let output_json = resp["outputJson"].as_str().map(|s| s.to_string());

                let dispatch_response = if let Some(err_msg) = error_msg {
                    // Error response
                    DispatchComponentResponse {
                        invocation_id,
                        success: false,
                        result: None,
                        error_message: err_msg,
                        metadata: HashMap::new(),
                        event_type: String::new(),
                        content_index: 0,
                        sequence: 0,
                        attempt: 0,
                        source_timestamp_ns: 0,
                    }
                } else {
                    // Success response
                    let output_bytes = output_json
                        .unwrap_or_else(|| "null".to_string())
                        .into_bytes();

                    DispatchComponentResponse {
                        invocation_id,
                        success: true,
                        result: Some(dispatch_component_response::Result::OutputData(output_bytes)),
                        error_message: String::new(),
                        metadata: HashMap::new(),
                        event_type: String::new(),
                        content_index: 0,
                        sequence: 0,
                        attempt: 0,
                        source_timestamp_ns: 0,
                    }
                };

                let service_msg = ServiceMessage {
                    worker_id: String::new(), // Will be set by core worker
                    metadata: HashMap::new(), // Always empty — metadata flows in inner response
                    message_type: Some(service_message::MessageType::FunctionResponse(dispatch_response)),
                };

                Ok(Some(service_msg))
            }
        };

        // Run the core worker
        // Lock the worker for the duration of run()
        let worker = self.core_worker.lock().await;

        worker
            .run(message_handler)
            .await
            .map_err(|e| Error::from_reason(format!("Worker run failed: {}", e)))?;

        Ok(())
    }
}

/// Initialize the SDK with logging and telemetry
#[napi]
pub fn initialize(service_name: String, service_version: Option<String>) -> Result<()> {
    let version = service_version.unwrap_or_else(|| "0.1.0".to_string());

    // Initialize logging
    agnt5_sdk_core::init_logging()
        .map_err(|e| Error::from_reason(format!("Failed to init logging: {}", e)))?;

    // Initialize telemetry
    agnt5_sdk_core::init_telemetry(&service_name, &version)
        .map_err(|e| Error::from_reason(format!("Failed to init telemetry: {}", e)))?;

    Ok(())
}

/// Get SDK version
#[napi]
pub fn get_version() -> String {
    "0.1.0".to_string()
}

/// Check if platform is reachable
#[napi]
pub async fn check_platform_connectivity(coordinator_url: String) -> Result<bool> {
    // Validate URL format first
    let _uri = coordinator_url
        .parse::<http::Uri>()
        .map_err(|e| Error::from_reason(format!("Invalid URL: {}", e)))?;

    // Try to connect to the health endpoint
    let health_url = format!("{}/health", coordinator_url.trim_end_matches('/'));

    match reqwest::get(&health_url).await {
        Ok(response) => Ok(response.status().is_success()),
        Err(_) => Ok(false), // Platform not reachable
    }
}

// =============================================================================
// State Management
// =============================================================================

/// Simple in-memory state manager for local execution
/// Can be extended to use platform-backed state later
#[napi]
pub struct StateManager {
    state: Arc<TokioMutex<HashMap<String, Vec<u8>>>>,
}

#[napi]
impl StateManager {
    /// Create a new in-memory state manager
    #[napi(constructor)]
    pub fn new() -> Self {
        StateManager {
            state: Arc::new(TokioMutex::new(HashMap::new())),
        }
    }

    /// Get a value from state
    #[napi]
    pub async fn get(&self, key: String) -> Result<Option<Buffer>> {
        let state = self.state.lock().await;
        match state.get(&key) {
            Some(value) => Ok(Some(Buffer::from(value.clone()))),
            None => Ok(None),
        }
    }

    /// Set a value in state
    #[napi]
    pub async fn set(&self, key: String, value: Buffer) -> Result<()> {
        let mut state = self.state.lock().await;
        state.insert(key, value.to_vec());
        Ok(())
    }

    /// Delete a value from state
    #[napi]
    pub async fn delete(&self, key: String) -> Result<bool> {
        let mut state = self.state.lock().await;
        Ok(state.remove(&key).is_some())
    }

    /// Get all keys in state
    #[napi]
    pub async fn keys(&self) -> Result<Vec<String>> {
        let state = self.state.lock().await;
        Ok(state.keys().cloned().collect())
    }

    /// Clear all state
    #[napi]
    pub async fn clear(&self) -> Result<()> {
        let mut state = self.state.lock().await;
        state.clear();
        Ok(())
    }

    /// Get the number of items in state
    #[napi]
    pub async fn size(&self) -> Result<i32> {
        let state = self.state.lock().await;
        Ok(state.len() as i32)
    }
}

// =============================================================================
// OpenTelemetry Span
// =============================================================================

/// OpenTelemetry Span for distributed tracing
#[napi]
pub struct Span {
    // For now, we'll use a simple wrapper
    // In the future, this will wrap sdk-core's telemetry::Span
    name: String,
    attributes: Arc<StdMutex<HashMap<String, String>>>,
    ended: Arc<StdMutex<bool>>,
}

#[napi]
impl Span {
    /// Create a new span with the given name
    #[napi(factory)]
    pub fn create(name: String) -> Self {
        Span {
            name,
            attributes: Arc::new(StdMutex::new(HashMap::new())),
            ended: Arc::new(StdMutex::new(false)),
        }
    }

    /// Get the span name
    #[napi(getter)]
    pub fn name(&self) -> String {
        self.name.clone()
    }

    /// Set a string attribute on the span
    #[napi]
    pub fn set_attribute(&self, key: String, value: String) -> Result<()> {
        let mut attrs = self.attributes.lock()
            .map_err(|e| Error::from_reason(format!("Failed to lock attributes: {}", e)))?;
        attrs.insert(key, value);
        Ok(())
    }

    /// Get all attributes
    #[napi]
    pub fn get_attributes(&self) -> Result<HashMap<String, String>> {
        let attrs = self.attributes.lock()
            .map_err(|e| Error::from_reason(format!("Failed to lock attributes: {}", e)))?;
        Ok(attrs.clone())
    }

    /// Add an event to the span
    #[napi]
    pub fn add_event(&self, name: String, attributes: Option<HashMap<String, String>>) -> Result<()> {
        // For now, just log it
        // TODO: connect to sdk-core's telemetry
        let attrs_str = attributes
            .map(|a| format!("{:?}", a))
            .unwrap_or_else(|| "{}".to_string());
        log::info!("Span event: {} on span '{}' with attributes: {}", name, self.name, attrs_str);
        Ok(())
    }

    /// Record an error on the span
    #[napi]
    pub fn record_error(&self, error: String) -> Result<()> {
        log::error!("Span error on '{}': {}", self.name, error);
        self.set_attribute("error".to_string(), "true".to_string())?;
        self.set_attribute("error.message".to_string(), error)?;
        Ok(())
    }

    /// End the span
    #[napi]
    pub fn end(&self) -> Result<()> {
        let mut ended = self.ended.lock()
            .map_err(|e| Error::from_reason(format!("Failed to lock ended flag: {}", e)))?;

        if *ended {
            return Err(Error::from_reason("Span already ended"));
        }

        *ended = true;
        log::info!("Span ended: {}", self.name);
        Ok(())
    }

    /// Check if span is ended
    #[napi]
    pub fn is_ended(&self) -> Result<bool> {
        let ended = self.ended.lock()
            .map_err(|e| Error::from_reason(format!("Failed to lock ended flag: {}", e)))?;
        Ok(*ended)
    }
}
