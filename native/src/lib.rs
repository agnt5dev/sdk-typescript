use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use agnt5_sdk_core::pb::{
    dispatch_component_response, ComponentInfo, ComponentType as PbComponentType,
    DispatchComponentRequest, DispatchComponentResponse, RuntimeMessage, ServiceMessage,
    TriggerSpec,
};
use agnt5_sdk_core::worker::{Worker as CoreWorker, WorkerConfig};
use agnt5_sdk_core::{JournalEventMessage, JournalEventQueue};

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex as TokioMutex;

// For logging in Span implementation
extern crate log;

fn sdk_core_builtin_scorer_response(
    worker_id: String,
    request: &DispatchComponentRequest,
) -> Option<ServiceMessage> {
    if request.component_type != PbComponentType::Scorer as i32 {
        return None;
    }

    let result = agnt5_sdk_core::eval::builtin_scorer::execute(
        &request.component_name,
        &request.input_data,
    )?;
    let output_data = serde_json::to_vec(&result).unwrap_or_default();
    let response = DispatchComponentResponse {
        invocation_id: request.invocation_id.clone(),
        success: true,
        result: Some(dispatch_component_response::Result::OutputData(output_data)),
        error_message: String::new(),
        metadata: request.metadata.clone(),
        event_type: "run.completed".to_string(),
        content_index: 0,
        sequence: 0,
        attempt: 0,
        source_timestamp_ns: 0,
        lease_id: request.lease_id.clone(),
    };

    Some(ServiceMessage {
        worker_id,
        metadata: HashMap::new(),
        message_type: Some(
            agnt5_sdk_core::pb::service_message::MessageType::FunctionResponse(response),
        ),
    })
}

// Chat SDK module
mod chat;

// Language model module
mod lm;

// MCP client bindings
mod mcp;

// Memory module (SemanticMemory + GraphMemory)
mod memory;

// Sandbox module (WasmSandbox + RemoteSandbox)
mod sandbox;

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
    /// Legacy engine routing key (falls back to AGNT5_PROJECT_ID). On
    /// worker/runtime paths this currently carries project identity; the
    /// metadata key flips to sub-tenant in Phase B of the identity cleanup.
    pub tenant_id: Option<String>,
    /// Deployment ID (falls back to AGNT5_DEPLOYMENT_ID env var)
    pub deployment_id: Option<String>,
    /// Max in-flight invocations this worker serves. Sets the local pool size
    /// and the coordinator's per-priority headroom denominator. Falls back to
    /// the AGNT5_MAX_CONCURRENCY env var, then 100.
    pub max_concurrency: Option<u32>,
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
    pub triggers: Option<Vec<TriggerSpecData>>,
}

/// Trigger declaration attached to a component registration
#[napi(object)]
pub struct TriggerSpecData {
    pub trigger_id: Option<String>,
    pub trigger_type: String,
    pub event_name: Option<String>,
    pub filter_expression: Option<String>,
    pub input_mapping: Option<String>,
    pub batch_window_ms: Option<i64>,
    pub delay_expression: Option<String>,
}

impl From<TriggerSpecData> for TriggerSpec {
    fn from(data: TriggerSpecData) -> Self {
        Self {
            trigger_id: data.trigger_id.unwrap_or_default(),
            trigger_type: data.trigger_type,
            event_name: data.event_name.unwrap_or_default(),
            filter_expression: data.filter_expression.unwrap_or_default(),
            input_mapping: data.input_mapping.unwrap_or_default(),
            batch_window_ms: data.batch_window_ms.unwrap_or_default(),
            delay_expression: data.delay_expression.unwrap_or_default(),
        }
    }
}

impl From<ComponentInfoData> for ComponentInfo {
    fn from(data: ComponentInfoData) -> Self {
        use agnt5_sdk_core::pb::ComponentType as PbComponentType;

        let config = data.config.unwrap_or_default();
        let metadata = data.metadata.unwrap_or_default();
        let triggers = data
            .triggers
            .unwrap_or_default()
            .into_iter()
            .map(Into::into)
            .collect();

        let max_attempts = config
            .get("max_attempts")
            .and_then(|v| v.parse::<i32>().ok());
        let initial_interval_ms = config
            .get("initial_interval_ms")
            .and_then(|v| v.parse::<i32>().ok());
        let max_interval_ms = config
            .get("max_interval_ms")
            .and_then(|v| v.parse::<i32>().ok());
        let backoff_type = config.get("backoff_type").cloned();
        let backoff_multiplier = config
            .get("backoff_multiplier")
            .and_then(|v| v.parse::<f64>().ok());

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
            config,
            metadata,
            definition: data.definition,
            max_attempts,
            initial_interval_ms,
            max_interval_ms,
            backoff_type,
            backoff_multiplier,
            triggers,
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
    message_handler:
        Arc<StdMutex<Option<ThreadsafeFunction<RuntimeMessageData, ErrorStrategy::Fatal>>>>,
    /// Fire-and-forget callback invoked with a run_id when a CancelExecution
    /// arrives, so JS can abort the matching invocation's AbortController.
    cancel_handler: Arc<StdMutex<Option<ThreadsafeFunction<String, ErrorStrategy::Fatal>>>>,
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
            options
                .service_version
                .unwrap_or_else(|| "0.1.0".to_string()),
            options
                .service_type
                .unwrap_or_else(|| "function".to_string()),
        );

        // Override coordinator endpoint if provided
        if let Some(endpoint) = options.coordinator_endpoint {
            config.coordinator_endpoint = endpoint;
        }

        // An explicit value from JS wins over the AGNT5_MAX_CONCURRENCY env
        // seed applied in WorkerConfig::new.
        if let Some(c) = options.max_concurrency {
            config.max_concurrency = Some(c);
        }

        // Build service metadata for checkpoint emission. `tenant_id` (the
        // metadata key) is reserved for the customer sub-tenant carried per
        // request; static worker metadata only stamps `project_id`.
        let mut metadata = HashMap::new();
        let project_id = options
            .tenant_id
            .clone()
            .or_else(|| std::env::var("AGNT5_PROJECT_ID").ok());
        if let Some(pid) = project_id {
            metadata.insert("project_id".to_string(), pid);
        }
        if let Some(ref did) = options.deployment_id {
            metadata.insert("deployment_id".to_string(), did.clone());
        } else if let Ok(did) = std::env::var("AGNT5_DEPLOYMENT_ID") {
            metadata.insert("deployment_id".to_string(), did);
        }

        // Create core worker with empty components initially
        let core_worker = CoreWorker::new(config.clone(), vec![], metadata);

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
            cancel_handler: Arc::new(StdMutex::new(None)),
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

    /// Get the legacy engine routing key from environment. On worker/runtime
    /// paths this currently carries project identity (read from
    /// `AGNT5_PROJECT_ID`).
    #[napi(getter)]
    pub fn tenant_id(&self) -> String {
        std::env::var("AGNT5_PROJECT_ID").unwrap_or_default()
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
        #[napi(ts_arg_type = "(message: RuntimeMessageData) => void")] callback: JsFunction,
    ) -> Result<()> {
        let tsfn: ThreadsafeFunction<RuntimeMessageData, ErrorStrategy::Fatal> =
            callback.create_threadsafe_function(0, |ctx| Ok(vec![ctx.value]))?;

        let mut handler = self
            .message_handler
            .lock()
            .map_err(|e| Error::from_reason(format!("Failed to lock message handler: {}", e)))?;
        *handler = Some(tsfn);

        Ok(())
    }

    /// Set the cancel handler callback. Invoked with a run_id (string) when a
    /// CancelExecution arrives so JS can abort the matching invocation.
    #[napi]
    pub fn set_cancel_handler(
        &self,
        #[napi(ts_arg_type = "(runId: string) => void")] callback: JsFunction,
    ) -> Result<()> {
        let tsfn: ThreadsafeFunction<String, ErrorStrategy::Fatal> =
            callback.create_threadsafe_function(0, |ctx| Ok(vec![ctx.value]))?;

        let mut handler = self
            .cancel_handler
            .lock()
            .map_err(|e| Error::from_reason(format!("Failed to lock cancel handler: {}", e)))?;
        *handler = Some(tsfn);

        Ok(())
    }

    /// Called by JS handler when async processing completes.
    /// Sends the response JSON back through the oneshot channel to the waiting Rust handler.
    #[napi]
    pub fn resolve_response(&self, invocation_id: String, response_json: String) -> Result<()> {
        let sender = {
            let mut map = self
                .response_map
                .lock()
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
            tenant_id: Some(std::env::var("AGNT5_PROJECT_ID").unwrap_or_default()),
            source_timestamp_ns: source_timestamp_ns as i64,
            metadata,
            queued_at: std::time::Instant::now(),
            is_streaming: true,
            is_sse_only,
            content_index,
            sequence,
        };
        self.journal_queue
            .push(event)
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
            let guard = self
                .emit_worker
                .lock()
                .map_err(|e| Error::from_reason(format!("Failed to lock emit_worker: {}", e)))?;
            guard
                .clone()
                .ok_or_else(|| Error::from_reason("emit_worker not available"))?
        };
        worker
            .emit_checkpoint_sync(
                run_id,
                event_type,
                event_data.into_bytes(),
                sequence_number,
                metadata,
                source_timestamp_ns as i64,
                timeout_ms.unwrap_or(5000.0) as u64,
            )
            .await
            .map_err(|e| Error::from_reason(format!("Checkpoint emission failed: {}", e)))?;
        Ok(())
    }

    /// Set components for registration
    #[napi]
    pub async fn set_components(&self, components: Vec<ComponentInfoData>) -> Result<()> {
        let component_infos: Vec<ComponentInfo> =
            components.into_iter().map(|c| c.into()).collect();

        // Update core worker's components
        let mut worker = self.core_worker.lock().await;
        worker.set_components(component_infos);

        Ok(())
    }

    /// Run the worker and connect to platform
    #[napi]
    pub async fn run(&self) -> Result<()> {
        // Verify message handler is set
        let handler = self
            .message_handler
            .lock()
            .map_err(|e| Error::from_reason(format!("Failed to lock message handler: {}", e)))?
            .clone()
            .ok_or_else(|| {
                Error::from_reason("Message handler not set. Call set_message_handler() first.")
            })?;

        // Shared response map for the handler closure
        let response_map = self.response_map.clone();
        let worker_id = self.config.worker_id.clone();

        // Create message handler that calls TypeScript callback
        let message_handler =
            move |runtime_msg: RuntimeMessage, _tx: flume::Sender<ServiceMessage>| {
                let handler_clone = handler.clone();
                let response_map = response_map.clone();
                let worker_id = worker_id.clone();

                async move {
                    use agnt5_sdk_core::pb::runtime_message;

                    // Extract DispatchComponentRequest from RuntimeMessage.
                    // Other message types (health checks, checkpoint acks, etc.) are
                    // handled internally by the core worker — skip them here.
                    let dispatch_request = match runtime_msg.message_data {
                        Some(runtime_message::MessageData::DispatchComponent(req)) => req,
                        _ => {
                            return Ok(None);
                        }
                    };

                    if let Some(response) =
                        sdk_core_builtin_scorer_response(worker_id, &dispatch_request)
                    {
                        return Ok(Some(response));
                    }

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
                    }
                    .to_string();

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
                        let mut map = response_map.lock().map_err(|e| {
                            agnt5_sdk_core::error::SdkError::Internal(format!(
                                "Failed to lock response map: {}",
                                e
                            ))
                        })?;
                        map.insert(invocation_id.clone(), tx);
                    }

                    // Fire-and-forget: send message to JS thread, don't wait for return value.
                    // napi-rs ThreadsafeFunction can't properly handle async (Promise) returns,
                    // so we use a separate channel (resolveResponse) for the result.
                    handler_clone.call(runtime_msg_data, ThreadsafeFunctionCallMode::NonBlocking);

                    // Wait for JS handler to call resolveResponse() (with 5 min timeout).
                    // We await completion but don't send the response on the bidi stream —
                    // all data flows through WriteCheckpoint to the Engine. The journal
                    // consumer handles load decrement when it sees run.completed/failed.
                    let _response_json =
                        tokio::time::timeout(std::time::Duration::from_secs(300), rx)
                            .await
                            .map_err(|_| {
                                agnt5_sdk_core::error::SdkError::Internal(format!(
                                    "Handler response timeout for invocation {}",
                                    invocation_id
                                ))
                            })?
                            .map_err(|_| {
                                agnt5_sdk_core::error::SdkError::Internal(format!(
                                    "Response channel dropped for invocation {}",
                                    invocation_id
                                ))
                            })?;

                    Ok(None)
                }
            };

        // Run the core worker
        // Lock the worker for the duration of run()
        let worker = self.core_worker.lock().await;

        // Register the cooperative cancel hook: forward run_id to the JS cancel
        // handler (which aborts the matching invocation's AbortController).
        if let Some(cancel_tsfn) = self.cancel_handler.lock().ok().and_then(|g| g.clone()) {
            worker.set_cancel_hook(move |run_id: String| {
                cancel_tsfn.call(run_id, ThreadsafeFunctionCallMode::NonBlocking);
            });
        }

        worker
            .run(message_handler)
            .await
            .map_err(|e| Error::from_reason(format!("Worker run failed: {}", e)))?;

        Ok(())
    }
}

/// Initialize the SDK with logging and telemetry.
///
/// Only `init_telemetry` is called — it installs the global tracing subscriber
/// (OTLP exporters + a filtered, clean console fmt layer). We deliberately do
/// NOT call `init_logging` as well: that installs a *second* subscriber with a
/// raw `info`-level stdout layer and races `init_telemetry` for
/// `set_global_default`, which (a) leaks internal Rust/OTEL infra logs
/// (`MeterProvider.GlobalSet`, `LoggerProvider.Drop`, journal queue, …) to
/// stdout and (b) makes the second init fail with "a global default trace
/// dispatcher has already been set". The Python SDK only calls `init_telemetry`
/// for exactly this reason; this keeps the TypeScript startup output clean and
/// the OTLP log/trace export functional. See AGNT5-586.
#[napi]
pub fn initialize(service_name: String, service_version: Option<String>) -> Result<()> {
    let version = service_version.unwrap_or_else(|| "0.1.0".to_string());

    // Initialize telemetry (installs the single global tracing subscriber).
    agnt5_sdk_core::init_telemetry(&service_name, &version)
        .map_err(|e| Error::from_reason(format!("Failed to init telemetry: {}", e)))?;

    Ok(())
}

/// Get SDK version
#[napi]
pub fn get_version() -> String {
    "0.1.0".to_string()
}

/// Forward TypeScript user logs to Rust tracing system for OpenTelemetry export.
///
/// This mirrors Python's `log_from_python` — user application logs are emitted through
/// Rust's tracing system with `log_source = "application"` so the control plane can
/// distinguish them from platform-internal logs.
#[napi]
pub fn log_from_typescript(
    level: String,
    message: String,
    run_id: Option<String>,
    trace_id: Option<String>,
    span_id: Option<String>,
    attributes: Option<HashMap<String, String>>,
) -> Result<()> {
    // Get effective tenant_id and deployment_id from global config
    let effective_tenant_id = agnt5_sdk_core::telemetry::get_tenant_id().map(|s| s.to_string());
    let effective_deployment_id =
        agnt5_sdk_core::telemetry::get_deployment_id().map(|s| s.to_string());

    // Serialize attributes to JSON for structured logging
    let attrs_json = attributes
        .as_ref()
        .map(|attrs| serde_json::to_string(attrs).unwrap_or_else(|_| "{}".to_string()));

    // Attach OpenTelemetry context if trace_id and span_id are provided
    let _cx_guard = if let (Some(ref tid_str), Some(ref sid_str)) = (&trace_id, &span_id) {
        use opentelemetry::trace::{SpanContext, SpanId, TraceContextExt, TraceFlags, TraceId};

        if let (Ok(tid_bytes), Ok(sid_bytes)) = (hex::decode(tid_str), hex::decode(sid_str)) {
            if tid_bytes.len() == 16 && sid_bytes.len() == 8 {
                let trace_id =
                    TraceId::from_bytes(tid_bytes.try_into().expect("trace_id length verified"));
                let span_id =
                    SpanId::from_bytes(sid_bytes.try_into().expect("span_id length verified"));

                let span_context = SpanContext::new(
                    trace_id,
                    span_id,
                    TraceFlags::SAMPLED,
                    false,
                    Default::default(),
                );

                let cx = opentelemetry::Context::current().with_remote_span_context(span_context);
                Some(cx.attach())
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    match level.to_uppercase().as_str() {
        "DEBUG" => tracing::debug!(
            target: "agnt5_sdk_typescript",
            log_source = "application",
            run_id = run_id.as_deref(),
            tenant_id = effective_tenant_id.as_deref(),
            deployment_id = effective_deployment_id.as_deref(),
            log_attributes = attrs_json.as_deref(),
            "{}",
            message
        ),
        "INFO" => tracing::info!(
            target: "agnt5_sdk_typescript",
            log_source = "application",
            run_id = run_id.as_deref(),
            tenant_id = effective_tenant_id.as_deref(),
            deployment_id = effective_deployment_id.as_deref(),
            log_attributes = attrs_json.as_deref(),
            "{}",
            message
        ),
        "WARNING" | "WARN" => tracing::warn!(
            target: "agnt5_sdk_typescript",
            log_source = "application",
            run_id = run_id.as_deref(),
            tenant_id = effective_tenant_id.as_deref(),
            deployment_id = effective_deployment_id.as_deref(),
            log_attributes = attrs_json.as_deref(),
            "{}",
            message
        ),
        "ERROR" => tracing::error!(
            target: "agnt5_sdk_typescript",
            log_source = "application",
            run_id = run_id.as_deref(),
            tenant_id = effective_tenant_id.as_deref(),
            deployment_id = effective_deployment_id.as_deref(),
            log_attributes = attrs_json.as_deref(),
            "{}",
            message
        ),
        _ => tracing::info!(
            target: "agnt5_sdk_typescript",
            log_source = "application",
            run_id = run_id.as_deref(),
            tenant_id = effective_tenant_id.as_deref(),
            deployment_id = effective_deployment_id.as_deref(),
            log_attributes = attrs_json.as_deref(),
            "[{}] {}",
            level,
            message
        ),
    }

    Ok(())
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
// OpenTelemetry Span (backed by sdk-core)
// =============================================================================

use opentelemetry::trace::{SpanContext, SpanId, TraceContextExt, TraceFlags, TraceId, TraceState};
use opentelemetry::Context as OtelContext;

/// Initialize OpenTelemetry telemetry (OTLP exporter, metrics, logs).
/// Call once at worker startup before creating any spans.
#[napi]
pub fn init_telemetry(service_name: String, service_version: String) -> Result<()> {
    agnt5_sdk_core::init_telemetry(&service_name, &service_version)
        .map_err(|e| Error::from_reason(format!("Failed to init telemetry: {}", e)))
}

/// Shut down OpenTelemetry gracefully, flushing any pending spans.
#[napi]
pub fn shutdown_telemetry() {
    agnt5_sdk_core::shutdown_telemetry();
}

/// OpenTelemetry Span backed by sdk-core's BoxedSpan.
/// Provides real distributed tracing via OTLP export.
#[napi]
pub struct Span {
    inner: StdMutex<Option<opentelemetry::global::BoxedSpan>>,
    name: String,
    trace_id: String,
    span_id: String,
    attributes: StdMutex<HashMap<String, String>>,
}

#[napi]
impl Span {
    /// Create a new span with the given name and component type.
    /// Optionally pass parent trace/span IDs for proper parent-child linking.
    #[napi(factory)]
    pub fn create(
        name: String,
        component_type: Option<String>,
        parent_trace_id: Option<String>,
        parent_span_id: Option<String>,
        attributes: Option<HashMap<String, String>>,
    ) -> Self {
        let comp_type = component_type.unwrap_or_else(|| "operation".to_string());

        // Build parent context from trace/span IDs if provided
        let parent_context = match (&parent_trace_id, &parent_span_id) {
            (Some(tid), Some(sid)) => {
                let trace_id = TraceId::from_hex(tid).unwrap_or(TraceId::INVALID);
                let span_id = SpanId::from_hex(sid).unwrap_or(SpanId::INVALID);
                if trace_id != TraceId::INVALID && span_id != SpanId::INVALID {
                    let span_context = SpanContext::new(
                        trace_id,
                        span_id,
                        TraceFlags::SAMPLED,
                        true, // is_remote
                        TraceState::default(),
                    );
                    Some(OtelContext::new().with_remote_span_context(span_context))
                } else {
                    None
                }
            }
            _ => None,
        };

        let metadata = attributes.unwrap_or_default();

        let span = agnt5_sdk_core::create_component_span(
            &name,
            &comp_type,
            "", // service_name — set via init_telemetry global
            "", // worker_id
            "", // run_id
            parent_context,
            Some(&metadata),
        );

        // Extract trace_id and span_id from the created span
        let (trace_id, span_id) = {
            use opentelemetry::trace::Span as OtelSpan;
            let ctx = span.span_context();
            if ctx.is_valid() {
                (ctx.trace_id().to_string(), ctx.span_id().to_string())
            } else {
                (String::new(), String::new())
            }
        };

        Span {
            inner: StdMutex::new(Some(span)),
            name,
            trace_id,
            span_id,
            attributes: StdMutex::new(HashMap::new()),
        }
    }

    /// Get the span name
    #[napi(getter)]
    pub fn name(&self) -> String {
        self.name.clone()
    }

    /// Get the trace ID (hex string)
    #[napi(getter)]
    pub fn trace_id(&self) -> String {
        self.trace_id.clone()
    }

    /// Get the span ID (hex string)
    #[napi(getter)]
    pub fn span_id(&self) -> String {
        self.span_id.clone()
    }

    /// Set a string attribute on the span
    #[napi]
    pub fn set_attribute(&self, key: String, value: String) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| Error::from_reason(format!("Span mutex poisoned: {}", e)))?;
        if let Some(ref mut span) = *guard {
            use opentelemetry::trace::Span as OtelSpan;
            span.set_attribute(opentelemetry::KeyValue::new(key.clone(), value.clone()));
        }
        // Track locally for getAttributes()
        if let Ok(mut attrs) = self.attributes.lock() {
            attrs.insert(key, value);
        }
        Ok(())
    }

    /// Get all attributes set on this span
    #[napi]
    pub fn get_attributes(&self) -> Result<HashMap<String, String>> {
        let attrs = self
            .attributes
            .lock()
            .map_err(|e| Error::from_reason(format!("Span attrs mutex poisoned: {}", e)))?;
        Ok(attrs.clone())
    }

    /// Add an event to the span
    #[napi]
    pub fn add_event(
        &self,
        name: String,
        attributes: Option<HashMap<String, String>>,
    ) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| Error::from_reason(format!("Span mutex poisoned: {}", e)))?;
        if let Some(ref mut span) = *guard {
            use opentelemetry::trace::Span as OtelSpan;
            let attrs: Vec<opentelemetry::KeyValue> = attributes
                .unwrap_or_default()
                .into_iter()
                .map(|(k, v)| opentelemetry::KeyValue::new(k, v))
                .collect();
            span.add_event(name, attrs);
        }
        Ok(())
    }

    /// Record an error on the span
    #[napi]
    pub fn record_error(&self, error: String) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| Error::from_reason(format!("Span mutex poisoned: {}", e)))?;
        if let Some(ref mut span) = *guard {
            use opentelemetry::trace::Span as OtelSpan;
            span.set_attribute(opentelemetry::KeyValue::new("error", true));
            span.set_attribute(opentelemetry::KeyValue::new("error.message", error.clone()));
            span.set_status(opentelemetry::trace::Status::error(error.clone()));
        }
        // Track locally for getAttributes()
        if let Ok(mut attrs) = self.attributes.lock() {
            attrs.insert("error".to_string(), "true".to_string());
            attrs.insert("error.message".to_string(), error);
        }
        Ok(())
    }

    /// End the span. Takes ownership of the inner span and drops it.
    /// Throws if the span has already been ended.
    #[napi]
    pub fn end(&self) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| Error::from_reason(format!("Span mutex poisoned: {}", e)))?;
        match guard.take() {
            Some(mut span) => {
                use opentelemetry::trace::Span as OtelSpan;
                span.end();
                Ok(())
            }
            None => Err(Error::from_reason("Span already ended")),
        }
    }

    /// Check if span has been ended
    #[napi]
    pub fn is_ended(&self) -> Result<bool> {
        let guard = self
            .inner
            .lock()
            .map_err(|e| Error::from_reason(format!("Span mutex poisoned: {}", e)))?;
        Ok(guard.is_none())
    }
}
