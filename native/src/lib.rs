use napi::bindgen_prelude::*;
use napi_derive::napi;

use agnt5_sdk_core::worker::WorkerConfig;

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

/// Worker for handling function invocations and platform connectivity
#[napi]
pub struct Worker {
    service_name: String,
    config: WorkerConfig,
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

        Ok(Worker {
            service_name: options.service_name,
            config,
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

    // TODO: Add run() method that connects to platform
    // This will require proper async handling with NAPI
    // For now, we focus on configuration and setup
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
    let uri = coordinator_url
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
