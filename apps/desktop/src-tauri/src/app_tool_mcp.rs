use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{ServerCapabilities, ServerConfig},
    schemars, tool, tool_handler, tool_router, ServerHandler, ServiceExt,
};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::time::Duration;

const MAX_MARKDOWN_BYTES: usize = 256 * 1024;
const MAX_TITLE_BYTES: usize = 240;
const MAX_FILE_REFS: usize = 64;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct OpenFileRequest {
    path: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct FileReference {
    path: String,
    line: Option<u32>,
    label: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct RenderAnswerRequest {
    version: u8,
    title: String,
    markdown: String,
    file_refs: Option<Vec<FileReference>>,
}

#[derive(Serialize)]
struct AppRequest<T: Serialize> {
    token: String,
    operation: &'static str,
    payload: T,
}

#[derive(Deserialize)]
struct AppResponse {
    ok: bool,
    result: Option<serde_json::Value>,
    error: Option<String>,
}

#[derive(Clone)]
pub struct AppToolServer {
    socket_path: String,
    token: String,
    tool_router: ToolRouter<Self>,
}

impl AppToolServer {
    fn from_environment() -> Result<Self, String> {
        let socket_path = std::env::var("PR_VISUALIZER_RENDER_SOCKET")
            .map_err(|_| "missing render socket".to_string())?;
        let token = std::env::var("PR_VISUALIZER_RENDER_TOKEN")
            .map_err(|_| "missing render token".to_string())?;
        Ok(Self {
            socket_path,
            token,
            tool_router: Self::tool_router(),
        })
    }

    fn call<T: Serialize>(
        &self,
        operation: &'static str,
        payload: T,
    ) -> Result<serde_json::Value, String> {
        #[cfg(unix)]
        {
            let mut stream = std::os::unix::net::UnixStream::connect(&self.socket_path)
                .map_err(|error| format!("app tool unavailable: {error}"))?;
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .map_err(|error| format!("could not set app tool timeout: {error}"))?;
            stream
                .set_write_timeout(Some(Duration::from_secs(10)))
                .map_err(|error| format!("could not set app tool timeout: {error}"))?;
            let request = AppRequest {
                token: self.token.clone(),
                operation,
                payload,
            };
            serde_json::to_writer(&mut stream, &request)
                .map_err(|error| format!("could not encode app tool request: {error}"))?;
            stream
                .write_all(b"\n")
                .map_err(|error| format!("could not send app tool request: {error}"))?;
            stream
                .flush()
                .map_err(|error| format!("could not flush app tool request: {error}"))?;
            let mut line = String::new();
            BufReader::new(stream)
                .read_line(&mut line)
                .map_err(|error| format!("could not read app tool response: {error}"))?;
            let response: AppResponse = serde_json::from_str(&line)
                .map_err(|_| "app tool returned invalid JSON".to_string())?;
            if !response.ok {
                return Err(response
                    .error
                    .unwrap_or_else(|| "app tool rejected request".into()));
            }
            response
                .result
                .ok_or_else(|| "app tool returned no result".into())
        }
        #[cfg(not(unix))]
        {
            let _ = (operation, payload);
            Err("app tools require a Unix socket on this platform".into())
        }
    }
}

#[tool_router]
impl AppToolServer {
    #[tool(description = "Get the pull request context for this terminal session.")]
    fn get_pr_context(&self) -> Result<String, String> {
        self.call("get_pr_context", serde_json::json!({}))
            .map(|value| value.to_string())
    }

    #[tool(description = "Open a repository-relative file in the PR Visualizer main diff viewer.")]
    fn open_file(
        &self,
        Parameters(OpenFileRequest { path }): Parameters<OpenFileRequest>,
    ) -> Result<String, String> {
        self.call("open_file", serde_json::json!({ "path": path }))
            .map(|value| value.to_string())
    }

    #[tool(description = "Render the final Markdown answer in the PR Visualizer answer window. Required whenever the answer mentions files or lines the reviewer may need to open, even for a short answer. Include every mentioned file in fileRefs with its line when known.")]
    fn render_answer(
        &self,
        Parameters(request): Parameters<RenderAnswerRequest>,
    ) -> Result<String, String> {
        if request.version != 1
            || request.title.is_empty()
            || request.title.len() > MAX_TITLE_BYTES
            || request.markdown.len() > MAX_MARKDOWN_BYTES
        {
            return Err("render_answer accepts version 1, a non-empty title up to 240 bytes, and Markdown up to 256 KiB".into());
        }
        if request
            .file_refs
            .as_ref()
            .is_some_and(|refs| refs.len() > MAX_FILE_REFS)
            || request
                .file_refs
                .as_ref()
                .is_some_and(|refs| refs.iter().any(|reference| reference.line == Some(0)))
        {
            return Err("render_answer accepts at most 64 file references".into());
        }
        self.call("render_answer", &request)
            .map(|_| "Answer rendered in PR Visualizer.".into())
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for AppToolServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_instructions("Use app tools for this one PR session. Whenever an answer mentions a file or line the reviewer may need to open, you must call render_answer successfully before finishing, even for a short answer. Include every mentioned file in fileRefs, with its line when known, and use repo-relative Markdown links or inline paths. If rendering fails, correct the request and retry, then report any unresolved failure. Use the terminal for progress, questions, and answers without file references. Call render_answer only for the final response, then give a brief terminal confirmation.")
    }
}

pub fn run_from_environment() -> Result<(), String> {
    let server = AppToolServer::from_environment()?;
    let runtime = tokio::runtime::Runtime::new()
        .map_err(|error| format!("could not start MCP runtime: {error}"))?;
    runtime.block_on(async move {
        server
            .serve(rmcp::transport::stdio())
            .await
            .map_err(|error| error.to_string())?
            .waiting()
            .await
            .map_err(|error| error.to_string())
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_server_advertises_all_app_tools() {
        // Arrange
        let server = AppToolServer {
            socket_path: "/tmp/not-used.sock".into(),
            token: "test-token".into(),
            tool_router: AppToolServer::tool_router(),
        };

        // Act
        let tools = server.tool_router.list_all();
        let names = tools
            .iter()
            .map(|tool| tool.name.as_ref())
            .collect::<Vec<_>>();

        // Assert
        assert_eq!(names, vec!["get_pr_context", "open_file", "render_answer"]);
    }

    #[tokio::test]
    async fn mcp_transport_lists_and_routes_tools_to_the_live_session_socket() {
        // Arrange
        let socket_path =
            std::env::temp_dir().join(format!("prv-mcp-transport-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket_path);
        let listener =
            std::os::unix::net::UnixListener::bind(&socket_path).expect("bind live session socket");
        let token = "live-session-token".to_string();
        let expected_token = token.clone();
        let (operation_sender, operation_receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().expect("accept app tool request");
                let mut request = String::new();
                BufReader::new(stream.try_clone().expect("clone request stream"))
                    .read_line(&mut request)
                    .expect("read app tool request");
                let request: serde_json::Value =
                    serde_json::from_str(&request).expect("decode app tool request");
                assert_eq!(request["token"], expected_token);
                operation_sender
                    .send(
                        request["operation"]
                            .as_str()
                            .expect("request operation")
                            .to_string(),
                    )
                    .expect("record app tool operation");
                serde_json::to_writer(
                    &mut stream,
                    &serde_json::json!({ "ok": true, "result": {} }),
                )
                .expect("write app tool response");
                stream
                    .write_all(b"\n")
                    .expect("terminate app tool response");
            }
        });
        let server = AppToolServer {
            socket_path: socket_path.to_string_lossy().into_owned(),
            token,
            tool_router: AppToolServer::tool_router(),
        };
        let (server_transport, client_transport) = tokio::io::duplex(64 * 1024);
        let server_task = tokio::spawn(async move {
            server
                .serve(server_transport)
                .await
                .expect("start MCP server transport")
                .waiting()
                .await
        });
        let client = ().serve(client_transport).await.expect("start MCP client transport");

        // Act
        let tools = client
            .peer()
            .list_tools(Default::default())
            .await
            .expect("list MCP tools");
        let context_result = client
            .call_tool(rmcp::model::CallToolRequestParams::new("get_pr_context"))
            .await
            .expect("route get_pr_context to the live socket");
        let open_file_arguments = serde_json::json!({ "path": "src/cache.rs" })
            .as_object()
            .expect("object arguments")
            .clone();
        let open_file_result = client
            .call_tool(
                rmcp::model::CallToolRequestParams::new("open_file")
                    .with_arguments(open_file_arguments),
            )
            .await
            .expect("route open_file to the live socket");
        client.cancel().await.expect("stop MCP client transport");
        server_task
            .await
            .expect("join MCP server task")
            .expect("stop MCP server transport");
        let operations = vec![
            operation_receiver
                .recv_timeout(Duration::from_secs(2))
                .expect("receive get_pr_context socket call"),
            operation_receiver
                .recv_timeout(Duration::from_secs(2))
                .expect("receive open_file socket call"),
        ];
        let _ = std::fs::remove_file(socket_path);

        // Assert
        assert_eq!(tools.tools.len(), 3);
        assert!(!context_result.is_error.unwrap_or(false));
        assert!(!open_file_result.is_error.unwrap_or(false));
        assert_eq!(operations, vec!["get_pr_context", "open_file"]);
    }
}
