use std::collections::HashMap;
use std::sync::Arc;

use agnt5_sdk_core::mcp::{McpClient, ServerConfig, SseConfig, StdioConfig, ToolContent};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::{json, Value};
use tokio::sync::Mutex;

#[napi(js_name = "MCPClientCore")]
pub struct McpClientCore {
    inner: Arc<Mutex<McpClient>>,
}

#[napi]
impl McpClientCore {
    #[napi(constructor)]
    pub fn new(id: String) -> Self {
        Self {
            inner: Arc::new(Mutex::new(McpClient::new(id))),
        }
    }

    #[napi(js_name = "addServer")]
    pub fn add_server(&self, name: String, config_json: String) -> Result<()> {
        let config_value: Value = serde_json::from_str(&config_json)
            .map_err(|e| Error::from_reason(format!("invalid server config json: {e}")))?;
        let server_config = parse_server_config(config_value)?;
        let mut client = self.inner.blocking_lock();
        client.add_server(name, server_config);
        Ok(())
    }

    #[napi(js_name = "addStdioServer")]
    pub fn add_stdio_server(
        &self,
        name: String,
        command: String,
        args: Option<Vec<String>>,
        env: Option<HashMap<String, String>>,
        cwd: Option<String>,
    ) {
        let mut client = self.inner.blocking_lock();
        client.add_server(
            name,
            ServerConfig::Stdio(StdioConfig {
                command,
                args: args.unwrap_or_default(),
                env: env.unwrap_or_default(),
                cwd,
            }),
        );
    }

    #[napi(js_name = "addSseServer")]
    pub fn add_sse_server(
        &self,
        name: String,
        url: String,
        headers: Option<HashMap<String, String>>,
        api_key: Option<String>,
    ) {
        let mut config = SseConfig::new(url);
        for (key, value) in headers.unwrap_or_default() {
            config = config.with_header(key, value);
        }
        if let Some(api_key) = api_key {
            config = config.with_api_key(api_key);
        }

        let mut client = self.inner.blocking_lock();
        client.add_server(name, ServerConfig::Sse(config));
    }

    #[napi]
    pub async fn connect(&self) -> Result<()> {
        let client = self.inner.lock().await;
        client
            .connect()
            .await
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub async fn disconnect(&self) -> Result<()> {
        let client = self.inner.lock().await;
        client
            .disconnect()
            .await
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi(js_name = "listToolsJson")]
    pub async fn list_tools_json(&self) -> Result<String> {
        let client = self.inner.lock().await;
        let tools = client
            .list_tools()
            .await
            .map_err(|e| Error::from_reason(e.to_string()))?;

        let items = tools
            .into_iter()
            .map(|item| {
                json!({
                    "server": item.server,
                    "tool": {
                        "name": item.tool.name,
                        "description": item.tool.description,
                        "inputSchema": item.tool.input_schema,
                    }
                })
            })
            .collect::<Vec<_>>();

        serde_json::to_string(&items).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi(js_name = "listServerToolsJson")]
    pub async fn list_server_tools_json(&self, server: String) -> Result<String> {
        let client = self.inner.lock().await;
        let tools = client
            .list_server_tools(&server)
            .await
            .map_err(|e| Error::from_reason(e.to_string()))?;

        let items = tools
            .into_iter()
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    "inputSchema": tool.input_schema,
                })
            })
            .collect::<Vec<_>>();

        serde_json::to_string(&items).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi(js_name = "callToolJson")]
    pub async fn call_tool_json(
        &self,
        server: String,
        tool_name: String,
        arguments_json: Option<String>,
    ) -> Result<String> {
        let arguments = parse_arguments(arguments_json)?;
        let client = self.inner.lock().await;
        let result = client
            .call_tool(&server, &tool_name, arguments)
            .await
            .map_err(|e| Error::from_reason(e.to_string()))?;

        serde_json::to_string(&call_tool_result_to_json(&result))
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi(js_name = "callToolAutoJson")]
    pub async fn call_tool_auto_json(
        &self,
        tool_name: String,
        arguments_json: Option<String>,
    ) -> Result<String> {
        let arguments = parse_arguments(arguments_json)?;
        let client = self.inner.lock().await;
        let result = client
            .call_tool_auto(&tool_name, arguments)
            .await
            .map_err(|e| Error::from_reason(e.to_string()))?;

        serde_json::to_string(&call_tool_result_to_json(&result))
            .map_err(|e| Error::from_reason(e.to_string()))
    }
}

fn parse_server_config(config: Value) -> Result<ServerConfig> {
    let obj = config
        .as_object()
        .ok_or_else(|| Error::from_reason("server config must be an object"))?;

    if let Some(command) = obj.get("command").and_then(Value::as_str) {
        let args = obj
            .get("args")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let env = obj
            .get("env")
            .and_then(Value::as_object)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        let cwd = obj
            .get("cwd")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);

        return Ok(ServerConfig::Stdio(StdioConfig {
            command: command.to_string(),
            args,
            env,
            cwd,
        }));
    }

    if let Some(url) = obj.get("url").and_then(Value::as_str) {
        let mut config = SseConfig::new(url.to_string());
        if let Some(headers) = obj.get("headers").and_then(Value::as_object) {
            for (key, value) in headers {
                if let Some(value) = value.as_str() {
                    config = config.with_header(key.clone(), value.to_string());
                }
            }
        }
        return Ok(ServerConfig::Sse(config));
    }

    Err(Error::from_reason(
        "Invalid server config: must have 'command' or 'url'",
    ))
}

fn parse_arguments(arguments_json: Option<String>) -> Result<Value> {
    match arguments_json {
        Some(arguments_json) => serde_json::from_str(&arguments_json)
            .map_err(|e| Error::from_reason(format!("invalid arguments json: {e}"))),
        None => Ok(Value::Null),
    }
}

fn call_tool_result_to_json(result: &agnt5_sdk_core::mcp::CallToolResult) -> Value {
    let content = result
        .content
        .iter()
        .map(tool_content_to_json)
        .collect::<Vec<_>>();
    json!({
        "content": content,
        "isError": result.is_error,
    })
}

fn tool_content_to_json(content: &ToolContent) -> Value {
    match content {
        ToolContent::Text { text } => json!({ "type": "text", "text": text }),
        ToolContent::Image { data, mime_type } => {
            json!({ "type": "image", "data": data, "mimeType": mime_type })
        }
        ToolContent::Resource { resource } => json!({
            "type": "resource",
            "resource": {
                "uri": resource.uri,
                "mimeType": resource.mime_type,
                "text": resource.text,
            }
        }),
    }
}
