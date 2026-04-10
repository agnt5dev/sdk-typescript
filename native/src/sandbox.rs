/// NAPI bindings for the AGNT5 Sandbox module.
///
/// Exposes `Sandbox` class to TypeScript backed by either WasmSandbox (embedded)
/// or RemoteSandbox (HTTP client).
use napi::bindgen_prelude::*;
use napi_derive::napi;

use agnt5_sdk_core::sandbox::{
    ExecuteCodeRequest, Language, RemoteSandbox, RemoteSandboxConfig, SandboxAuth,
    SandboxBackendKind, SandboxExecutor, SandboxWorkspace, WriteFileRequest,
};
use std::collections::HashMap;
use std::sync::Arc;

#[cfg(feature = "wasm-sandbox")]
use agnt5_sdk_core::sandbox::{WasmSandbox, WasmSandboxConfig};

type BoxedExecutor = Arc<dyn SandboxExecutor>;
type BoxedWorkspace = Arc<dyn SandboxWorkspace>;

// ── Result types as JS objects ──────────────────────────────────

#[napi(object)]
pub struct SandboxExecuteResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub execution_time_ms: f64,
    pub error: Option<String>,
}

#[napi(object)]
pub struct SandboxWriteResult {
    pub success: bool,
    pub path: String,
    pub size: f64,
    pub error: Option<String>,
}

#[napi(object)]
pub struct SandboxReadResult {
    pub path: String,
    pub content: Buffer,
    pub size: f64,
    pub is_dir: bool,
    pub error: Option<String>,
}

#[napi(object)]
pub struct SandboxFileInfo {
    pub name: String,
    pub path: String,
    pub size: f64,
    pub is_dir: bool,
    pub mode: u32,
    pub mod_time: f64,
}

#[napi(object)]
pub struct SandboxListResult {
    pub path: String,
    pub total: f64,
    pub files: Vec<SandboxFileInfo>,
    pub error: Option<String>,
}

#[napi(object)]
pub struct SandboxHealthResult {
    pub status: String,
    pub sandbox_id: String,
    pub uptime_ms: f64,
    pub backend_kind: String,
    pub error: Option<String>,
}

#[napi(object)]
pub struct SandboxCapabilities {
    pub languages: Vec<String>,
    pub supports_commands: bool,
    pub supports_git: bool,
    pub supports_preview_url: bool,
    pub supports_streaming: bool,
    pub supports_snapshots: bool,
    pub has_network_access: bool,
}

#[napi(object)]
pub struct SandboxOptions {
    /// "remote", "wasm", or "auto" (default).
    pub backend: Option<String>,
    /// HTTP endpoint for remote backend.
    pub endpoint: Option<String>,
    /// Sandbox instance ID.
    pub sandbox_id: Option<String>,
    /// API key for remote auth.
    pub api_key: Option<String>,
    /// Bearer token for remote auth.
    pub bearer_token: Option<String>,
    /// Request timeout in seconds.
    pub timeout_secs: Option<f64>,
    /// Path prefix for remote API routes (e.g. "/v1/sandbox" for AGNT5 platform).
    pub api_prefix: Option<String>,
    /// Path to QuickJS WASI binary (for wasm backend).
    pub quickjs_wasm_path: Option<String>,
}

// ── Sandbox class ───────────────────────────────────────────────

#[napi]
pub struct Sandbox {
    executor: BoxedExecutor,
    workspace: BoxedWorkspace,
    backend_kind: SandboxBackendKind,
}

#[napi]
impl Sandbox {
    #[napi(constructor)]
    pub fn new(options: Option<SandboxOptions>) -> Result<Self> {
        let opts = options.unwrap_or(SandboxOptions {
            backend: None,
            endpoint: None,
            sandbox_id: None,
            api_key: None,
            bearer_token: None,
            timeout_secs: None,
            api_prefix: None,
            quickjs_wasm_path: None,
        });

        let backend_str = opts.backend.as_deref().unwrap_or("auto");
        let timeout =
            std::time::Duration::from_secs(opts.timeout_secs.unwrap_or(300.0) as u64);

        match backend_str {
            "remote" => {
                let ep = opts.endpoint.ok_or_else(|| {
                    Error::from_reason("endpoint is required for remote backend")
                })?;
                let remote = create_remote(ep, opts.sandbox_id, opts.api_key, opts.bearer_token, timeout, opts.api_prefix)?;
                let arc: Arc<RemoteSandbox> = Arc::new(remote);
                Ok(Sandbox {
                    executor: arc.clone() as BoxedExecutor,
                    workspace: arc as BoxedWorkspace,
                    backend_kind: SandboxBackendKind::Remote,
                })
            }

            #[cfg(feature = "wasm-sandbox")]
            "wasm" => {
                let wasm = create_wasm(opts.quickjs_wasm_path)?;
                let arc: Arc<WasmSandbox> = Arc::new(wasm);
                Ok(Sandbox {
                    executor: arc.clone() as BoxedExecutor,
                    workspace: arc as BoxedWorkspace,
                    backend_kind: SandboxBackendKind::Wasm,
                })
            }

            #[cfg(not(feature = "wasm-sandbox"))]
            "wasm" => Err(Error::from_reason(
                "WasmSandbox is not available. Rebuild with the wasm-sandbox feature.",
            )),

            "auto" => {
                if let Some(ep) = opts.endpoint {
                    let remote = create_remote(ep, opts.sandbox_id, opts.api_key, opts.bearer_token, timeout, opts.api_prefix)?;
                    let arc: Arc<RemoteSandbox> = Arc::new(remote);
                    Ok(Sandbox {
                        executor: arc.clone() as BoxedExecutor,
                        workspace: arc as BoxedWorkspace,
                        backend_kind: SandboxBackendKind::Remote,
                    })
                } else {
                    #[cfg(feature = "wasm-sandbox")]
                    {
                        let wasm = create_wasm(opts.quickjs_wasm_path)?;
                        let arc: Arc<WasmSandbox> = Arc::new(wasm);
                        Ok(Sandbox {
                            executor: arc.clone() as BoxedExecutor,
                            workspace: arc as BoxedWorkspace,
                            backend_kind: SandboxBackendKind::Wasm,
                        })
                    }
                    #[cfg(not(feature = "wasm-sandbox"))]
                    Err(Error::from_reason(
                        "No sandbox backend available. Provide endpoint for remote, or rebuild with wasm-sandbox feature.",
                    ))
                }
            }

            other => Err(Error::from_reason(format!(
                "Unknown backend: '{}'. Use 'remote', 'wasm', or 'auto'.",
                other
            ))),
        }
    }

    #[napi(getter)]
    pub fn backend(&self) -> String {
        self.backend_kind.to_string()
    }

    #[napi]
    pub fn capabilities(&self) -> SandboxCapabilities {
        let caps = self.executor.capabilities();
        SandboxCapabilities {
            languages: caps.languages.iter().map(|l| l.to_string()).collect(),
            supports_commands: caps.supports_commands,
            supports_git: caps.supports_git,
            supports_preview_url: caps.supports_preview_url,
            supports_streaming: caps.supports_streaming,
            supports_snapshots: caps.supports_snapshots,
            has_network_access: caps.has_network_access,
        }
    }

    #[napi]
    pub async fn execute_code(
        &self,
        code: String,
        language: Option<String>,
        timeout_ms: Option<f64>,
    ) -> Result<SandboxExecuteResult> {
        let lang = parse_language(language.as_deref().unwrap_or("javascript"))?;
        let req = ExecuteCodeRequest {
            code,
            language: lang,
            timeout_ms: timeout_ms.unwrap_or(30_000.0) as u64,
            env: None,
            work_dir: None,
        };
        let result = self.executor.execute_code(req).await.map_err(|e| {
            Error::from_reason(format!("execute_code failed: {}", e))
        })?;
        Ok(SandboxExecuteResult {
            stdout: result.stdout,
            stderr: result.stderr,
            exit_code: result.exit_code,
            execution_time_ms: result.execution_time_ms as f64,
            error: result.error,
        })
    }

    #[napi]
    pub async fn write_file(&self, path: String, content: Buffer) -> Result<SandboxWriteResult> {
        let req = WriteFileRequest {
            path: path.clone(),
            content: content.to_vec(),
            mode: 0o644,
        };
        let result = self.workspace.write_file(req).await.map_err(|e| {
            Error::from_reason(format!("write_file failed: {}", e))
        })?;
        Ok(SandboxWriteResult {
            success: result.success,
            path: result.path,
            size: result.size as f64,
            error: result.error,
        })
    }

    #[napi]
    pub async fn read_file(&self, path: String) -> Result<SandboxReadResult> {
        let result = self.workspace.read_file(&path).await.map_err(|e| {
            Error::from_reason(format!("read_file failed: {}", e))
        })?;
        Ok(SandboxReadResult {
            path: result.path,
            content: Buffer::from(result.content),
            size: result.size as f64,
            is_dir: result.is_dir,
            error: result.error,
        })
    }

    #[napi]
    pub async fn delete_file(&self, path: String, recursive: Option<bool>) -> Result<bool> {
        self.workspace
            .delete_file(&path, recursive.unwrap_or(false))
            .await
            .map_err(|e| Error::from_reason(format!("delete_file failed: {}", e)))
    }

    #[napi]
    pub async fn list_files(
        &self,
        path: Option<String>,
        recursive: Option<bool>,
    ) -> Result<SandboxListResult> {
        let p = path.as_deref().unwrap_or(".");
        let result = self
            .workspace
            .list_files(p, recursive.unwrap_or(false))
            .await
            .map_err(|e| Error::from_reason(format!("list_files failed: {}", e)))?;
        Ok(SandboxListResult {
            path: result.path,
            total: result.total as f64,
            files: result
                .files
                .into_iter()
                .map(|f| SandboxFileInfo {
                    name: f.name,
                    path: f.path,
                    size: f.size as f64,
                    is_dir: f.is_dir,
                    mode: f.mode,
                    mod_time: f.mod_time as f64,
                })
                .collect(),
            error: result.error,
        })
    }

    #[napi]
    pub async fn health(&self) -> Result<SandboxHealthResult> {
        let result = self.executor.health().await.map_err(|e| {
            Error::from_reason(format!("health check failed: {}", e))
        })?;
        Ok(SandboxHealthResult {
            status: result.status,
            sandbox_id: result.sandbox_id,
            uptime_ms: result.uptime_ms as f64,
            backend_kind: result.backend_kind.to_string(),
            error: result.error,
        })
    }
}

// ── Helpers ─────────────────────────────────────────────────────

fn parse_language(s: &str) -> Result<Language> {
    match s.to_lowercase().as_str() {
        "javascript" | "js" => Ok(Language::Javascript),
        "python" | "py" => Ok(Language::Python),
        "bash" | "sh" => Ok(Language::Bash),
        other => Err(Error::from_reason(format!(
            "Unknown language: '{}'. Use 'javascript', 'python', or 'bash'.",
            other
        ))),
    }
}

fn create_remote(
    endpoint: String,
    sandbox_id: Option<String>,
    api_key: Option<String>,
    bearer_token: Option<String>,
    timeout: std::time::Duration,
    api_prefix: Option<String>,
) -> Result<RemoteSandbox> {
    let auth = if let Some(key) = api_key {
        SandboxAuth::ApiKey(key)
    } else if let Some(token) = bearer_token {
        SandboxAuth::BearerToken(token)
    } else {
        SandboxAuth::None
    };
    let config = RemoteSandboxConfig {
        endpoint,
        sandbox_id: sandbox_id.unwrap_or_else(|| "default".to_string()),
        auth,
        timeout,
        api_prefix: api_prefix.unwrap_or_default(),
    };
    RemoteSandbox::new(config)
        .map_err(|e| Error::from_reason(format!("Failed to create RemoteSandbox: {}", e)))
}

#[cfg(feature = "wasm-sandbox")]
fn create_wasm(quickjs_wasm_path: Option<String>) -> Result<WasmSandbox> {
    let config = WasmSandboxConfig {
        quickjs_wasm_path: quickjs_wasm_path.map(std::path::PathBuf::from),
        ..Default::default()
    };
    WasmSandbox::new(config)
        .map_err(|e| Error::from_reason(format!("Failed to create WasmSandbox: {}", e)))
}
