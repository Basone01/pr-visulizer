use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const MAX_SOCKET_REQUEST_BYTES: usize = 512 * 1024;
const MAX_MARKDOWN_BYTES: usize = 256 * 1024;
const MAX_TITLE_BYTES: usize = 240;
const MAX_FILE_REFS: usize = 64;
const MAX_RETAINED_INACTIVE_REPORTS: usize = 8;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAnswerContext {
    pub owner: String,
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub base_sha: String,
    pub head_sha: String,
    pub selected_file_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAnswerContextUpdateRequest {
    pub session_id: String,
    pub context: CodexAnswerContext,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAnswerSessionRequest {
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAnswerOpenFileRequest {
    pub session_id: String,
    pub path: String,
    pub line: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileReference {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderAnswerRequest {
    version: u8,
    title: String,
    markdown: String,
    file_refs: Option<Vec<FileReference>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerReport {
    version: u8,
    session_id: String,
    title: String,
    markdown: String,
    file_refs: Vec<FileReference>,
    updated_at: String,
}

#[derive(Deserialize)]
struct SocketRequest {
    token: String,
    operation: String,
    payload: serde_json::Value,
}

#[derive(Serialize)]
struct SocketResponse {
    ok: bool,
    result: Option<serde_json::Value>,
    error: Option<String>,
}

struct SocketHost {
    path: std::path::PathBuf,
    stop_sender: mpsc::Sender<()>,
}

struct AnswerSession {
    context: CodexAnswerContext,
    report: Option<AnswerReport>,
    active: bool,
    socket: Option<SocketHost>,
}

#[derive(Clone, Default)]
pub struct CodexAnswerSessions {
    sessions: Arc<Mutex<HashMap<String, AnswerSession>>>,
}

impl CodexAnswerSessions {
    pub fn start<R: Runtime>(
        &self,
        app: tauri::AppHandle<R>,
        session_id: &str,
        context: CodexAnswerContext,
    ) -> Result<(String, String), String> {
        validate_context(&context)?;
        if self
            .sessions
            .lock()
            .map_err(|_| "answer session state is unavailable".to_string())?
            .contains_key(session_id)
        {
            return Err("an answer session with this ID already exists".into());
        }
        let token = session_token(session_id);
        let socket_path = socket_path(session_id, &token)?;
        let listener = bind_socket(&socket_path)?;
        let (stop_sender, stop_receiver) = mpsc::channel();
        let session_store = self.clone();
        let socket_session_id = session_id.to_string();
        let socket_token = token.clone();

        let session = AnswerSession {
            context,
            report: None,
            active: true,
            socket: Some(SocketHost {
                path: socket_path.clone(),
                stop_sender,
            }),
        };
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "answer session state is unavailable".to_string())?;
        if sessions.contains_key(session_id) {
            let _ = std::fs::remove_file(&socket_path);
            return Err("an answer session with this ID already exists".into());
        }
        sessions.insert(session_id.to_string(), session);
        drop(sessions);
        thread::spawn(move || {
            serve_socket(
                app,
                session_store,
                socket_session_id,
                socket_token,
                listener,
                stop_receiver,
            );
        });
        Ok((socket_path.to_string_lossy().into_owned(), token))
    }

    pub fn revoke(&self, session_id: &str) {
        let socket = self.sessions.lock().ok().and_then(|mut sessions| {
            let session = sessions.get_mut(session_id)?;
            session.active = false;
            let socket = session.socket.take();
            if session.report.is_none() {
                sessions.remove(session_id);
            } else {
                prune_inactive_reports(&mut sessions);
            }
            socket
        });
        if let Some(socket) = socket {
            let _ = socket.stop_sender.send(());
            let _ = std::fs::remove_file(socket.path);
        }
    }

    pub fn shutdown(&self) {
        let session_ids = self
            .sessions
            .lock()
            .map(|sessions| sessions.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for session_id in session_ids {
            self.revoke(&session_id);
        }
    }

    fn update_context(&self, request: CodexAnswerContextUpdateRequest) -> Result<(), String> {
        validate_context(&request.context)?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "answer session state is unavailable".to_string())?;
        let session = sessions
            .get_mut(&request.session_id)
            .ok_or_else(|| "answer session is no longer available".to_string())?;
        if session.context.owner != request.context.owner
            || session.context.repo != request.context.repo
            || session.context.number != request.context.number
            || session.context.base_sha != request.context.base_sha
            || session.context.head_sha != request.context.head_sha
        {
            return Err("answer context cannot change this terminal session's PR identity".into());
        }
        session.context.title = request.context.title;
        session.context.selected_file_path = request.context.selected_file_path;
        Ok(())
    }

    fn report(&self, session_id: &str) -> Result<Option<AnswerReport>, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "answer session state is unavailable".to_string())?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| "answer session is no longer available".to_string())?;
        Ok(session.report.clone())
    }

    fn active_context(&self, session_id: &str) -> Result<CodexAnswerContext, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "answer session state is unavailable".to_string())?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| "answer session is no longer available".to_string())?;
        if !session.active {
            return Err("terminal session is no longer active".into());
        }
        Ok(session.context.clone())
    }

    fn store_report(
        &self,
        session_id: &str,
        request: RenderAnswerRequest,
    ) -> Result<AnswerReport, String> {
        validate_render_request(&request)?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "answer session state is unavailable".to_string())?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| "answer session is no longer available".to_string())?;
        if !session.active {
            return Err("terminal session is no longer active".into());
        }
        let report = AnswerReport {
            version: request.version,
            session_id: session_id.to_string(),
            title: request.title,
            markdown: request.markdown,
            file_refs: request.file_refs.unwrap_or_default(),
            updated_at: timestamp(),
        };
        session.report = Some(report.clone());
        Ok(report)
    }
}

fn serve_socket<R: Runtime>(
    app: tauri::AppHandle<R>,
    sessions: CodexAnswerSessions,
    session_id: String,
    token: String,
    listener: std::os::unix::net::UnixListener,
    stop_receiver: mpsc::Receiver<()>,
) {
    let _ = listener.set_nonblocking(true);
    loop {
        if stop_receiver.try_recv().is_ok() {
            return;
        }
        match listener.accept() {
            Ok((stream, _)) => handle_socket_request(&app, &sessions, &session_id, &token, stream),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10))
            }
            Err(_) => return,
        }
    }
}

fn handle_socket_request<R: Runtime>(
    app: &tauri::AppHandle<R>,
    sessions: &CodexAnswerSessions,
    session_id: &str,
    token: &str,
    mut stream: std::os::unix::net::UnixStream,
) {
    let response = (|| -> Result<serde_json::Value, String> {
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .map_err(|error| format!("could not set request timeout: {error}"))?;
        let mut request_bytes = Vec::with_capacity(4096);
        BufReader::new(stream.try_clone().map_err(|error| error.to_string())?)
            .take((MAX_SOCKET_REQUEST_BYTES + 1) as u64)
            .read_until(b'\n', &mut request_bytes)
            .map_err(|error| format!("could not read app tool request: {error}"))?;
        if request_bytes.len() > MAX_SOCKET_REQUEST_BYTES {
            return Err("app tool request exceeds 512 KiB".into());
        }
        let request: SocketRequest = serde_json::from_slice(&request_bytes)
            .map_err(|_| "app tool request is not valid JSON".to_string())?;
        if request.token != token {
            return Err("app tool token is invalid".into());
        }
        match request.operation.as_str() {
            "get_pr_context" if request.payload == serde_json::json!({}) => {
                serde_json::to_value(sessions.active_context(session_id)?)
                    .map_err(|error| error.to_string())
            }
            "open_file" => {
                let request: OpenFilePayload = serde_json::from_value(request.payload)
                    .map_err(|_| "open_file requires a path".to_string())?;
                validate_relative_path(&request.path)?;
                validate_optional_line(request.line)?;
                sessions.active_context(session_id)?;
                open_file_in_main_window(app, session_id, &request.path, request.line)?;
                Ok(serde_json::json!({ "opened": true }))
            }
            "render_answer" => {
                let request: RenderAnswerRequest = serde_json::from_value(request.payload)
                    .map_err(|_| "render_answer request is invalid".to_string())?;
                let report = sessions.store_report(session_id, request)?;
                show_report_window(app, &report)?;
                app.emit("codex-answer://updated", &report)
                    .map_err(|error| error.to_string())?;
                Ok(serde_json::json!({ "rendered": true }))
            }
            _ => Err("unknown app tool operation".into()),
        }
    })();
    let response = match response {
        Ok(result) => SocketResponse {
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(error) => SocketResponse {
            ok: false,
            result: None,
            error: Some(error),
        },
    };
    let _ = serde_json::to_writer(&mut stream, &response);
    let _ = stream.write_all(b"\n");
    let _ = stream.flush();
}

#[derive(Deserialize)]
struct OpenFilePayload {
    path: String,
    line: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenFileEvent<'a> {
    session_id: &'a str,
    path: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<u32>,
}

fn open_file_in_main_window<R: Runtime>(
    app: &tauri::AppHandle<R>,
    session_id: &str,
    path: &str,
    line: Option<u32>,
) -> Result<(), String> {
    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    main_window.show().map_err(|error| error.to_string())?;
    main_window.set_focus().map_err(|error| error.to_string())?;

    app.emit(
        "codex-answer://open-file",
        OpenFileEvent {
            session_id,
            path,
            line,
        },
    )
    .map_err(|error| error.to_string())
}

fn show_report_window<R: Runtime>(
    app: &tauri::AppHandle<R>,
    report: &AnswerReport,
) -> Result<(), String> {
    let label = report_window_label(&report.session_id);
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let url = format!("index.html?answerSession={}", report.session_id);
    WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title(&report.title)
        .inner_size(900.0, 760.0)
        .build()
        .map_err(|error| format!("could not open answer window: {error}"))?;
    Ok(())
}

fn show_stored_report<R: Runtime>(
    app: &tauri::AppHandle<R>,
    sessions: &CodexAnswerSessions,
    session_id: &str,
) -> Result<(), String> {
    let Some(report) = sessions.report(session_id)? else {
        return Err("no answer has been rendered for this terminal session".into());
    };

    show_report_window(app, &report)
}

#[tauri::command]
pub fn codex_terminal_update_context(
    sessions: tauri::State<'_, CodexAnswerSessions>,
    request: CodexAnswerContextUpdateRequest,
) -> Result<(), String> {
    sessions.update_context(request)
}

#[tauri::command]
pub fn codex_answer_window_state(
    sessions: tauri::State<'_, CodexAnswerSessions>,
    request: CodexAnswerSessionRequest,
) -> Result<Option<AnswerReport>, String> {
    sessions.report(&request.session_id)
}

#[tauri::command]
pub fn codex_answer_window_open_file<R: Runtime>(
    app: tauri::AppHandle<R>,
    sessions: tauri::State<'_, CodexAnswerSessions>,
    request: CodexAnswerOpenFileRequest,
) -> Result<(), String> {
    validate_relative_path(&request.path)?;
    validate_optional_line(request.line)?;
    sessions.active_context(&request.session_id)?;
    open_file_in_main_window(&app, &request.session_id, &request.path, request.line)
}

#[tauri::command]
pub fn codex_answer_window_show<R: Runtime>(
    app: tauri::AppHandle<R>,
    sessions: tauri::State<'_, CodexAnswerSessions>,
    request: CodexAnswerSessionRequest,
) -> Result<(), String> {
    show_stored_report(&app, sessions.inner(), &request.session_id)
}

fn validate_context(context: &CodexAnswerContext) -> Result<(), String> {
    if context.owner.is_empty()
        || context.repo.is_empty()
        || context.number == 0
        || context.base_sha.is_empty()
        || context.head_sha.is_empty()
    {
        return Err("answer context must identify a pull request".into());
    }
    if let Some(path) = &context.selected_file_path {
        validate_relative_path(path)?;
    }
    Ok(())
}

fn validate_render_request(request: &RenderAnswerRequest) -> Result<(), String> {
    if request.version != 1
        || request.title.is_empty()
        || request.title.len() > MAX_TITLE_BYTES
        || request.markdown.len() > MAX_MARKDOWN_BYTES
    {
        return Err("render_answer accepts version 1, a non-empty title up to 240 bytes, and Markdown up to 256 KiB".into());
    }
    let refs = request.file_refs.as_deref().unwrap_or_default();
    if refs.len() > MAX_FILE_REFS {
        return Err("render_answer accepts at most 64 file references".into());
    }
    for reference in refs {
        validate_relative_path(&reference.path)?;
        validate_optional_line(reference.line)?;
    }
    Ok(())
}

fn validate_optional_line(line: Option<u32>) -> Result<(), String> {
    if line == Some(0) {
        return Err("file reference lines must be greater than zero".into());
    }

    Ok(())
}

fn validate_relative_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 4096 || path.contains('\0') {
        return Err("file path must be a non-empty relative path".into());
    }
    let path = Path::new(path);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("file path must stay within the repository".into());
    }
    Ok(())
}

fn socket_path(_session_id: &str, token: &str) -> Result<std::path::PathBuf, String> {
    let directory = std::env::temp_dir().join("pr-visualizer-mcp");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("could not create answer socket directory: {error}"))?;
    #[cfg(unix)]
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("could not secure answer socket directory: {error}"))?;
    let path = directory.join(format!("{}.sock", &token[..24]));
    if path.as_os_str().len() >= 100 {
        return Err("answer socket path is too long".into());
    }
    Ok(path)
}

fn bind_socket(path: &Path) -> Result<std::os::unix::net::UnixListener, String> {
    let _ = std::fs::remove_file(path);
    let listener = std::os::unix::net::UnixListener::bind(path)
        .map_err(|error| format!("could not bind answer socket: {error}"))?;
    #[cfg(unix)]
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("could not secure answer socket: {error}"))?;
    Ok(listener)
}

fn session_token(_session_id: &str) -> String {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).expect("the operating system random source must be available");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn report_window_label(session_id: &str) -> String {
    format!("codex-answer-{session_id}")
}

fn timestamp() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .expect("RFC 3339 timestamps always format")
}

fn prune_inactive_reports(sessions: &mut HashMap<String, AnswerSession>) {
    let mut inactive_reports = sessions
        .iter()
        .filter_map(|(session_id, session)| {
            (!session.active)
                .then(|| {
                    session
                        .report
                        .as_ref()
                        .map(|report| (session_id.clone(), report.updated_at.clone()))
                })
                .flatten()
        })
        .collect::<Vec<_>>();
    inactive_reports.sort_by(|left, right| right.1.cmp(&left.1));
    for (session_id, _) in inactive_reports
        .into_iter()
        .skip(MAX_RETAINED_INACTIVE_REPORTS)
    {
        sessions.remove(&session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> CodexAnswerContext {
        CodexAnswerContext {
            owner: "acme".into(),
            repo: "widgets".into(),
            number: 42,
            title: "Review widget cache".into(),
            base_sha: "base1234".into(),
            head_sha: "head1234".into(),
            selected_file_path: Some("src/cache.rs".into()),
        }
    }

    fn socket_request(socket_path: &str, request: serde_json::Value) -> serde_json::Value {
        let mut stream = std::os::unix::net::UnixStream::connect(socket_path)
            .expect("connect to live answer socket");
        serde_json::to_writer(&mut stream, &request).expect("encode socket request");
        stream.write_all(b"\n").expect("terminate socket request");
        stream.flush().expect("flush socket request");
        let mut response = String::new();
        BufReader::new(stream)
            .read_line(&mut response)
            .expect("read socket response");
        serde_json::from_str(&response).expect("decode socket response")
    }

    #[test]
    fn live_socket_returns_context_and_revokes_stale_calls() {
        // Arrange
        let app = tauri::test::mock_app();
        let sessions = CodexAnswerSessions::default();
        let session_id = "answer-socket-test";
        let (socket_path, token) = sessions
            .start(app.handle().clone(), session_id, context())
            .expect("start answer socket");
        let context_request = serde_json::json!({
            "token": token,
            "operation": "get_pr_context",
            "payload": {}
        });

        // Act
        let response = socket_request(&socket_path, context_request);
        sessions.revoke(session_id);

        // Assert
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["owner"], "acme");
        assert!(
            std::os::unix::net::UnixStream::connect(&socket_path).is_err(),
            "revoking a terminal must remove its app-tool socket"
        );
    }

    #[test]
    fn show_stored_report_reports_a_session_without_an_answer() {
        // Arrange
        let app = tauri::test::mock_app();
        let sessions = CodexAnswerSessions::default();
        let session_id = "answer-show-without-report";
        sessions
            .start(app.handle().clone(), session_id, context())
            .expect("start answer session");

        // Act
        let result = show_stored_report(app.handle(), &sessions, session_id);
        sessions.revoke(session_id);

        // Assert
        let expected = Err("no answer has been rendered for this terminal session".to_string());
        assert_eq!(result, expected);
    }

    #[test]
    fn context_updates_cannot_change_pr_identity() {
        // Arrange
        let sessions = CodexAnswerSessions::default();
        let session_id = "identity-test";
        let mut next_context = context();
        next_context.head_sha = "another-head".into();
        let session = AnswerSession {
            context: context(),
            report: None,
            active: true,
            socket: None,
        };
        sessions
            .sessions
            .lock()
            .expect("lock answer sessions")
            .insert(session_id.into(), session);

        // Act
        let result = sessions.update_context(CodexAnswerContextUpdateRequest {
            session_id: session_id.into(),
            context: next_context,
        });

        // Assert
        assert_eq!(
            result.expect_err("identity replacement must fail"),
            "answer context cannot change this terminal session's PR identity"
        );
    }

    #[test]
    fn report_serialization_omits_absent_file_reference_fields() {
        // Arrange
        let report = AnswerReport {
            version: 1,
            session_id: "report-test".into(),
            title: "Answer".into(),
            markdown: "# Answer".into(),
            file_refs: vec![FileReference {
                path: "src/cache.rs".into(),
                line: None,
                label: None,
            }],
            updated_at: "2026-10-02T12:00:00Z".into(),
        };

        // Act
        let value = serde_json::to_value(report).expect("serialize answer report");

        // Assert
        assert!(value["fileRefs"][0].get("line").is_none());
        assert!(value["fileRefs"][0].get("label").is_none());
    }

    #[test]
    fn opening_a_file_emits_its_optional_line_after_focusing_main_window() {
        // Arrange
        use tauri::Listener;

        let app = tauri::test::mock_app();
        WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .build()
            .expect("create main window");
        let received = Arc::new(Mutex::new(None));
        let recorded_event = Arc::clone(&received);
        app.handle()
            .listen("codex-answer://open-file", move |event| {
                let payload = serde_json::from_str::<serde_json::Value>(event.payload())
                    .expect("decode open-file event");
                *recorded_event.lock().expect("lock recorded event") = Some(payload);
            });
        let session_id = "answer-window-test";
        let path = "src/cache.rs";
        let line = Some(42);

        // Act
        open_file_in_main_window(&app.handle(), session_id, path, line)
            .expect("open file in the main window");

        // Assert
        let expected = serde_json::json!({
            "sessionId": session_id,
            "path": path,
            "line": 42,
        });
        assert_eq!(
            *received.lock().expect("read recorded event"),
            Some(expected)
        );
    }

    #[test]
    fn file_reference_lines_must_be_positive_when_present() {
        // Arrange
        let zero_line = Some(0);

        // Act
        let result = validate_optional_line(zero_line);

        // Assert
        let expected = "file reference lines must be greater than zero";
        assert_eq!(
            result.expect_err("zero is not a valid line number"),
            expected
        );
    }
}
