use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{ServerCapabilities, ServerConfig},
    schemars,
    service::RequestContext,
    tool, tool_handler, tool_router, RoleServer, ServerHandler, ServiceExt,
};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::time::Duration;

use crate::ai_chat_approval::DEFAULT_APPROVAL_TIMEOUT;
use crate::codex_answer::{AnswerPresentation, ANSWER_PRESENTATION_ENV};

// A little above the app's expiry, so the app's own deny always arrives first.
const HELPER_APPROVAL_READ_TIMEOUT: Duration =
    Duration::from_secs(DEFAULT_APPROVAL_TIMEOUT.as_secs() + 30);

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

// What the CLI sends to the prompt tool, forwarded to the app unchanged.
#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
struct ApprovalPromptRequest {
    tool_name: String,
    input: serde_json::Value,
    tool_use_id: Option<String>,
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
    presentation: AnswerPresentation,
    tool_router: ToolRouter<Self>,
}

// The terminal wording is unchanged from before the chat existed. The chat wording makes the
// chat reply the default answer, because a rendered answer there shows inline, not in a window.
const WINDOW_INSTRUCTIONS: &str = "Use app tools for this one PR session. Whenever an answer mentions a file or line the reviewer may need to open, you must call render_answer successfully before finishing, even for a short answer. Include every mentioned file in fileRefs, with its line when known, and use repo-relative Markdown links or inline paths. If rendering fails, correct the request and retry, then report any unresolved failure. Use the terminal for progress, questions, and answers without file references. Call render_answer only for the final response, then give a brief terminal confirmation. Call get_current_file first when the reviewer asks about 'this file', 'these lines' or 'here'.";
const INLINE_INSTRUCTIONS: &str = "Use app tools for this one PR session. Answer in the chat by default, your reply is what the reviewer reads. render_answer is optional. When you use it, include every mentioned file in fileRefs with its line when known. Its answer is shown inline in the chat, so do not repeat it in your reply, add at most one short sentence. If rendering fails, correct the request and retry, or answer in the chat instead. Call get_current_file first when the reviewer asks about 'this file', 'these lines' or 'here'.";
const INLINE_RENDER_ANSWER_DESCRIPTION: &str = "Show a Markdown answer inline in the PR Visualizer chat. Optional, answering in the chat reply is the default. Include every mentioned file in fileRefs with its line when known. The answer already appears in the chat, so do not repeat it in your reply.";
const WINDOW_RENDER_RESULT: &str = "Answer rendered in PR Visualizer.";
const INLINE_RENDER_RESULT: &str =
    "Answer shown inline in the chat. Do not repeat it in your reply.";

impl AnswerPresentation {
    fn server_instructions(self) -> &'static str {
        match self {
            Self::Window => WINDOW_INSTRUCTIONS,
            Self::Inline => INLINE_INSTRUCTIONS,
        }
    }

    fn render_result(self) -> &'static str {
        match self {
            Self::Window => WINDOW_RENDER_RESULT,
            Self::Inline => INLINE_RENDER_RESULT,
        }
    }
}

// Only the render_answer description changes by surface. Names and input schemas stay identical.
fn tool_router_for(presentation: AnswerPresentation) -> ToolRouter<AppToolServer> {
    let mut router = AppToolServer::tool_router();
    if presentation == AnswerPresentation::Inline {
        router.merge(AppToolServer::approval_tool_router());
        if let Some(route) = router.map.get_mut("render_answer") {
            route.attr.description = Some(INLINE_RENDER_ANSWER_DESCRIPTION.into());
        }
    }
    router
}

impl AppToolServer {
    fn from_environment() -> Result<Self, String> {
        let socket_path = std::env::var("PR_VISUALIZER_RENDER_SOCKET")
            .map_err(|_| "missing render socket".to_string())?;
        let token = std::env::var("PR_VISUALIZER_RENDER_TOKEN")
            .map_err(|_| "missing render token".to_string())?;
        let presentation = std::env::var(ANSWER_PRESENTATION_ENV).ok();
        let presentation = AnswerPresentation::from_helper_env(presentation.as_deref());
        Ok(Self {
            socket_path,
            token,
            presentation,
            tool_router: tool_router_for(presentation),
        })
    }

    fn call<T: Serialize>(
        &self,
        operation: &'static str,
        payload: T,
    ) -> Result<serde_json::Value, String> {
        #[cfg(unix)]
        {
            let stream = self.send_request(operation, payload, Duration::from_secs(10))?;
            read_response(stream)
        }
        #[cfg(not(unix))]
        {
            let _ = (operation, payload);
            Err("app tools require a Unix socket on this platform".into())
        }
    }

    #[cfg(unix)]
    fn send_request<T: Serialize>(
        &self,
        operation: &'static str,
        payload: T,
        read_timeout: Duration,
    ) -> Result<std::os::unix::net::UnixStream, String> {
        let mut stream = std::os::unix::net::UnixStream::connect(&self.socket_path)
            .map_err(|error| format!("app tool unavailable: {error}"))?;
        stream
            .set_read_timeout(Some(read_timeout))
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
        Ok(stream)
    }

    // The CLI waits on this answer, so every failure becomes a deny instead of a tool error.
    // When the CLI cancels the prompt, hanging up tells the app nobody is waiting any more.
    async fn ask_reviewer(
        &self,
        prompt: ApprovalPromptRequest,
        context: RequestContext<RoleServer>,
    ) -> String {
        #[cfg(unix)]
        {
            let stream = match self.send_request("approve", &prompt, HELPER_APPROVAL_READ_TIMEOUT) {
                Ok(stream) => stream,
                Err(error) => return helper_deny(&error),
            };
            let hang_up = match stream.try_clone() {
                Ok(hang_up) => hang_up,
                Err(error) => return helper_deny(&error.to_string()),
            };
            let reply = tokio::task::spawn_blocking(move || read_response(stream));
            tokio::select! {
                joined = reply => match joined {
                    Ok(Ok(answer)) => answer.to_string(),
                    Ok(Err(error)) => helper_deny(&error),
                    Err(_) => helper_deny("the app stopped answering"),
                },
                _ = context.ct.cancelled() => {
                    let _ = hang_up.shutdown(std::net::Shutdown::Both);
                    helper_deny("Claude cancelled the request")
                }
            }
        }
        #[cfg(not(unix))]
        {
            let _ = (prompt, context);
            helper_deny("approvals need a Unix socket on this platform")
        }
    }
}

#[cfg(unix)]
fn read_response(stream: std::os::unix::net::UnixStream) -> Result<serde_json::Value, String> {
    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .map_err(|error| format!("could not read app tool response: {error}"))?;
    let response: AppResponse =
        serde_json::from_str(&line).map_err(|_| "app tool returned invalid JSON".to_string())?;
    if !response.ok {
        return Err(response
            .error
            .unwrap_or_else(|| "app tool rejected request".into()));
    }
    response
        .result
        .ok_or_else(|| "app tool returned no result".into())
}

fn helper_deny(reason: &str) -> String {
    let message = format!(
        "PR Visualizer could not ask the reviewer: {reason}. Do not retry it. Continue with a simpler read-only command."
    );
    serde_json::json!({ "behavior": "deny", "message": message }).to_string()
}

// Answers the CLI's permission prompts (`--permission-prompt-tool`). The CLI keeps it out of the
// model's tool list. It is served only for chat sessions, the terminal asks in its own UI.
#[tool_router(router = approval_tool_router)]
impl AppToolServer {
    #[tool(
        description = "Answers Claude Code permission prompts for the PR Visualizer chat by asking the reviewer. Used through --permission-prompt-tool, not by the model."
    )]
    async fn approve(
        &self,
        Parameters(prompt): Parameters<ApprovalPromptRequest>,
        context: RequestContext<RoleServer>,
    ) -> Result<String, String> {
        Ok(self.ask_reviewer(prompt, context).await)
    }
}

#[tool_router]
impl AppToolServer {
    #[tool(
        description = "Get the pull request context for this terminal session. Files marked skipped are treated as generated and not read by default, a file whose diff is omitted is still reviewed in bounded pieces."
    )]
    fn get_pr_context(&self) -> Result<String, String> {
        self.call("get_pr_context", serde_json::json!({}))
            .map(|value| value.to_string())
    }

    #[tool(
        description = "See the file the reviewer has open in PR Visualizer, its review status, and the line range they selected, if any. Read the file content from the repository at the head SHA yourself."
    )]
    fn get_current_file(&self) -> Result<String, String> {
        self.call("get_current_file", serde_json::json!({}))
            .map(|value| value.to_string())
    }

    #[tool(
        description = "List every file in the pull request in the reviewer's queue order, with its status, whether the reviewer marked it reviewed, and which one the app suggests next. Files marked skipped are treated as generated and not read by default, a file whose diff is omitted is still reviewed in bounded pieces."
    )]
    fn list_pr_files(&self) -> Result<String, String> {
        self.call("list_pr_files", serde_json::json!({}))
            .map(|value| value.to_string())
    }

    #[tool(
        description = "List the reviewer's pending inline comment drafts for this pull request. Drafts are not published. Each draft has a side: for RIGHT its lines are head line numbers, for LEFT (a comment on a deleted line) its lines are base line numbers."
    )]
    fn get_review_drafts(&self) -> Result<String, String> {
        self.call("get_review_drafts", serde_json::json!({}))
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

    #[tool(
        description = "Render the final Markdown answer in the PR Visualizer answer window. Required whenever the answer mentions files or lines the reviewer may need to open, even for a short answer. Include every mentioned file in fileRefs with its line when known."
    )]
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
            .map(|_| self.presentation.render_result().into())
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for AppToolServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(self.presentation.server_instructions())
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
    fn terminal_keeps_required_render_answer_wording_and_chat_makes_it_optional_and_inline() {
        // Arrange
        let terminal = AnswerPresentation::Window;
        let chat = AnswerPresentation::Inline;

        // Act
        let terminal_instructions = terminal.server_instructions();
        let chat_instructions = chat.server_instructions();
        let terminal_result = terminal.render_result();
        let chat_result = chat.render_result();

        // Assert
        assert!(terminal_instructions.contains("you must call render_answer successfully"));
        assert!(terminal_instructions.contains("Use the terminal for progress"));
        assert_eq!(terminal_result, "Answer rendered in PR Visualizer.");
        assert!(chat_instructions.contains("Answer in the chat by default"));
        assert!(chat_instructions.contains("render_answer is optional"));
        assert!(chat_instructions.contains("shown inline in the chat, so do not repeat it"));
        assert!(!chat_instructions.contains("terminal"));
        let expected_chat_result =
            "Answer shown inline in the chat. Do not repeat it in your reply.";
        assert_eq!(chat_result, expected_chat_result);
    }

    #[tokio::test]
    async fn chat_helper_advertises_inline_wording_the_same_app_tools_and_the_prompt_tool() {
        // Arrange
        let server = AppToolServer {
            socket_path: "/tmp/not-used.sock".into(),
            token: "test-token".into(),
            presentation: AnswerPresentation::Inline,
            tool_router: tool_router_for(AnswerPresentation::Inline),
        };
        let terminal_tools = AppToolServer::tool_router().list_all();
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
        let instructions = client
            .peer_info()
            .and_then(|info| info.instructions.clone());
        let chat_tools = client
            .peer()
            .list_tools(Default::default())
            .await
            .expect("list MCP tools")
            .tools;
        client.cancel().await.expect("stop MCP client transport");
        let _ = server_task.await;

        // Assert
        assert_eq!(instructions.as_deref(), Some(INLINE_INSTRUCTIONS));
        let shape = |tools: &[rmcp::model::Tool]| {
            let mut shape: Vec<(String, serde_json::Value)> = tools
                .iter()
                .map(|tool| {
                    let schema = serde_json::Value::Object((*tool.input_schema).clone());
                    (tool.name.to_string(), schema)
                })
                .collect();
            shape.sort_by(|left, right| left.0.cmp(&right.0));
            shape
        };
        let chat_app_tools: Vec<rmcp::model::Tool> = chat_tools
            .iter()
            .filter(|tool| tool.name != "approve")
            .cloned()
            .collect();
        assert_eq!(shape(&chat_app_tools), shape(&terminal_tools));
        assert!(
            chat_tools.iter().any(|tool| tool.name == "approve"),
            "the chat helper must serve the permission prompt tool"
        );
        let render_answer = chat_tools
            .iter()
            .find(|tool| tool.name == "render_answer")
            .expect("render_answer is listed");
        assert_eq!(
            render_answer.description.as_deref(),
            Some(INLINE_RENDER_ANSWER_DESCRIPTION)
        );
    }

    #[test]
    fn only_the_chat_helper_serves_the_permission_prompt_tool() {
        // Arrange
        let terminal = AnswerPresentation::Window;
        let chat = AnswerPresentation::Inline;

        // Act
        let terminal_router = tool_router_for(terminal);
        let chat_router = tool_router_for(chat);

        // Assert
        assert!(!terminal_router.has_route("approve"));
        assert!(chat_router.has_route("approve"));
    }

    #[test]
    fn a_helper_failure_is_answered_as_a_deny_the_cli_accepts() {
        // Arrange
        let reason = "app tool unavailable: connection refused";

        // Act
        let answer: serde_json::Value =
            serde_json::from_str(&helper_deny(reason)).expect("deny is JSON");

        // Assert
        let expected = serde_json::json!({
            "behavior": "deny",
            "message": "PR Visualizer could not ask the reviewer: app tool unavailable: connection refused. Do not retry it. Continue with a simpler read-only command.",
        });
        assert_eq!(answer, expected);
    }

    #[test]
    fn mcp_server_advertises_all_app_tools() {
        // Arrange
        let server = AppToolServer {
            socket_path: "/tmp/not-used.sock".into(),
            token: "test-token".into(),
            presentation: AnswerPresentation::Window,
            tool_router: AppToolServer::tool_router(),
        };

        // Act
        let tools = server.tool_router.list_all();
        let names = tools
            .iter()
            .map(|tool| tool.name.as_ref())
            .collect::<Vec<_>>();

        // Assert
        let expected = vec![
            "get_current_file",
            "get_pr_context",
            "get_review_drafts",
            "list_pr_files",
            "open_file",
            "render_answer",
        ];
        assert_eq!(names, expected);
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
            for _ in 0..3 {
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
            presentation: AnswerPresentation::Window,
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
        let current_file_result = client
            .call_tool(rmcp::model::CallToolRequestParams::new("get_current_file"))
            .await
            .expect("route get_current_file to the live socket");
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
            operation_receiver
                .recv_timeout(Duration::from_secs(2))
                .expect("receive get_current_file socket call"),
        ];
        let _ = std::fs::remove_file(socket_path);

        // Assert
        assert_eq!(tools.tools.len(), 6);
        assert!(!context_result.is_error.unwrap_or(false));
        assert!(!open_file_result.is_error.unwrap_or(false));
        assert!(!current_file_result.is_error.unwrap_or(false));
        assert_eq!(
            operations,
            vec!["get_pr_context", "open_file", "get_current_file"]
        );
    }
}
