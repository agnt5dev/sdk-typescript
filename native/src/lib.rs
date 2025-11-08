use napi::bindgen_prelude::*;
use napi_derive::napi;
use napi::threadsafe_function::{
    ThreadsafeFunction, ErrorStrategy,
};

use agnt5_sdk_core::worker::{Worker as CoreWorker, WorkerConfig};
use agnt5_sdk_core::pb::{RuntimeMessage, ServiceMessage, ComponentInfo};

use std::sync::{Arc, Mutex};
use std::collections::HashMap;

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
    /// Tenant ID
    pub tenant_id: Option<String>,
    /// Deployment ID
    pub deployment_id: Option<String>,
}

/// Component type enum matching protobuf
#[napi(string_enum)]
pub enum ComponentType {
    Function,
    Workflow,
    Agent,
    Tool,
    Entity,
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

        // Parse component type from string
        let component_type = match data.component_type.to_lowercase().as_str() {
            "function" => PbComponentType::Function as i32,
            "workflow" => PbComponentType::Workflow as i32,
            "agent" => PbComponentType::Agent as i32,
            "tool" => PbComponentType::Tool as i32,
            "entity" => PbComponentType::Entity as i32,
            _ => PbComponentType::Function as i32, // default to function
        };

        ComponentInfo {
            name: data.name,
            component_type,
            input_schema: None,  // Will be set later from TypeScript schemas
            output_schema: None, // Will be set later from TypeScript schemas
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
    core_worker: Arc<CoreWorker>,
    message_handler: Arc<Mutex<Option<ThreadsafeFunction<RuntimeMessageData, ErrorStrategy::Fatal>>>>,
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

        // Override config from options if provided
        if let Some(endpoint) = options.coordinator_endpoint {
            config.coordinator_endpoint = endpoint;
        }
        if let Some(tenant) = options.tenant_id {
            config.tenant_id = tenant;
        }
        if let Some(deployment) = options.deployment_id {
            config.deployment_id = deployment;
        }

        // Create core worker with empty components initially
        let core_worker = CoreWorker::new(
            config.clone(),
            vec![],
            HashMap::new(),
        );

        Ok(Worker {
            service_name: options.service_name,
            config,
            core_worker: Arc::new(core_worker),
            message_handler: Arc::new(Mutex::new(None)),
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

    /// Get tenant ID
    #[napi(getter)]
    pub fn tenant_id(&self) -> String {
        self.config.tenant_id.clone()
    }

    /// Get deployment ID
    #[napi(getter)]
    pub fn deployment_id(&self) -> String {
        self.config.deployment_id.clone()
    }

    /// Set the message handler callback
    #[napi]
    pub fn set_message_handler(
        &self,
        #[napi(ts_arg_type = "(message: RuntimeMessageData) => Promise<ServiceMessageData | null>")]
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

    /// Set components for registration
    #[napi]
    pub fn set_components(&self, components: Vec<ComponentInfoData>) -> Result<()> {
        let _component_infos: Vec<ComponentInfo> = components
            .into_iter()
            .map(|c| c.into())
            .collect();

        // Update core worker's components
        // Note: CoreWorker::set_components requires mutable access
        // For now, we'll need to recreate the worker or use interior mutability
        // This is a temporary limitation we'll address in the next iteration

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

        // Clone Arc for moving into async block
        let core_worker = self.core_worker.clone();

        // Create message handler that calls TypeScript callback
        let message_handler = move |runtime_msg: RuntimeMessage, _tx: flume::Sender<ServiceMessage>| {
            let handler_clone = handler.clone();

            async move {
                use agnt5_sdk_core::pb::{runtime_message, service_message, ExecuteComponentResponse};

                // Extract ExecuteComponentRequest from RuntimeMessage
                let execute_request = match runtime_msg.message_data {
                    Some(runtime_message::MessageData::ExecuteComponent(req)) => req,
                    _ => {
                        return Err(agnt5_sdk_core::error::SdkError::Internal(
                            "Expected ExecuteComponentRequest".to_string()
                        ));
                    }
                };

                // Convert component type to string
                let component_type_str = match execute_request.component_type {
                    1 => "function",
                    2 => "workflow",
                    3 => "agent",
                    4 => "tool",
                    5 => "entity",
                    _ => "unknown",
                }.to_string();

                // Convert input_data bytes to JSON string
                let input_json = String::from_utf8(execute_request.input_data.clone())
                    .unwrap_or_else(|_| "{}".to_string());

                // Create simplified RuntimeMessageData for TypeScript
                let runtime_msg_data = RuntimeMessageData {
                    invocation_id: execute_request.invocation_id.clone(),
                    component_name: execute_request.component_name.clone(),
                    component_type: component_type_str,
                    input_json,
                    metadata: execute_request.metadata.clone(),
                };

                // Call TypeScript handler
                let response: Option<ServiceMessageData> = handler_clone
                    .call_async(runtime_msg_data)
                    .await
                    .map_err(|e| agnt5_sdk_core::error::SdkError::Internal(
                        format!("TypeScript handler error: {}", e)
                    ))?;

                // Convert response to ServiceMessage
                if let Some(resp) = response {
                    let execute_response = if let Some(err_msg) = resp.error {
                        // Error response
                        ExecuteComponentResponse {
                            invocation_id: resp.invocation_id,
                            success: false,
                            result: None,
                            error_message: err_msg,
                            metadata: HashMap::new(),
                            is_chunk: false,
                            done: true,
                            chunk_index: 0,
                            attempt: 0,
                        }
                    } else {
                        // Success response
                        let output_bytes = resp.output_json
                            .unwrap_or_else(|| "null".to_string())
                            .into_bytes();

                        ExecuteComponentResponse {
                            invocation_id: resp.invocation_id,
                            success: true,
                            result: Some(agnt5_sdk_core::pb::execute_component_response::Result::OutputData(output_bytes)),
                            error_message: String::new(),
                            metadata: HashMap::new(),
                            is_chunk: false,
                            done: true,
                            chunk_index: 0,
                            attempt: 0,
                        }
                    };

                    let service_msg = ServiceMessage {
                        worker_id: String::new(), // Will be set by core worker
                        message_type: Some(service_message::MessageType::FunctionResponse(execute_response)),
                    };

                    Ok(Some(service_msg))
                } else {
                    Ok(None)
                }
            }
        };

        // Run the core worker
        core_worker
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
    // Most coordinators should have a health check endpoint
    let health_url = format!("{}/health", coordinator_url.trim_end_matches('/'));

    match reqwest::get(&health_url).await {
        Ok(response) => Ok(response.status().is_success()),
        Err(_) => Ok(false), // Platform not reachable
    }
}
