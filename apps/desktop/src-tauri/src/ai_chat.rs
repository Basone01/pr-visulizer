// The chat surface runs Claude Code headless, as one long-lived child that speaks stream-json over
// pipes. Rust stays a bounded line pipe: it frames stdout into lines and forwards them unparsed.
// The webview never writes raw stdin, Rust builds every stdin line itself.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Runtime};

use crate::codex_answer::{AnswerPresentation, CodexAnswerContext, CodexAnswerSessions};
#[cfg(unix)]
use crate::codex_terminal::stop_process_group;
use crate::codex_terminal::{
    claude_safety_profile, linked_repository_root, validated_model, validated_session_id,
    TerminalProvider,
};

const MAX_SYSTEM_PROMPT_APPEND_BYTES: usize = 64 * 1024;
const MAX_USER_TEXT_BYTES: usize = 256 * 1024;
const STDERR_TAIL_BYTES: usize = 4 * 1024;
const DISPATCH_QUEUE_CAPACITY: usize = 64;
const READ_CHUNK_BYTES: usize = 64 * 1024;
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(20);

// The CLI accepts unknown names silently, so each name here was checked against the real
// init tool list (Claude Code 2.1.322, 2026-11-12).
const CHAT_BUILT_IN_TOOLS: &[&str] = &["Bash", "Read", "Grep", "Glob"];
// Plugin directories passed through the environment load plugins and their hooks, which
// `--setting-sources ""` does not cover. Only the chat drops them, the terminal keeps the
// user's own setup.
const CHAT_REMOVED_ENV: &[&str] = &["CLAUDE_CODE_PLUGIN_DIRS"];

// The chat shows a rendered answer inline, the window opens only on the reviewer's request.
const CHAT_ANSWER_PRESENTATION: AnswerPresentation = AnswerPresentation::Inline;

const LINE_EVENT: &str = "ai-chat://line";
const EXIT_EVENT: &str = "ai-chat://exit";

const DEFAULT_PIPE_LIMITS: ChatPipeLimits = ChatPipeLimits {
    max_line_bytes: 4 * 1024 * 1024,
    max_preattach_bytes: 8 * 1024 * 1024,
};

// Generations tell a late cleanup of an ended session apart from a new session with the same ID.
static NEXT_SESSION_GENERATION: AtomicU64 = AtomicU64::new(1);
static NEXT_INTERRUPT_REQUEST: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatStartRequest {
    pub session_id: String,
    pub provider: TerminalProvider,
    pub repository_path: String,
    pub model: Option<String>,
    pub system_prompt_append: String,
    pub context: CodexAnswerContext,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatSendRequest {
    pub session_id: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatSessionRequest {
    pub session_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatStartResponse {
    pub session_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiChatLineEvent {
    session_id: String,
    sequence: u64,
    line: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiChatExitEvent {
    session_id: String,
    code: Option<i32>,
    error: Option<String>,
}

#[derive(Clone, Copy, Debug)]
struct ChatPipeLimits {
    max_line_bytes: usize,
    max_preattach_bytes: usize,
}

#[derive(Debug, PartialEq)]
struct ChatExit {
    code: Option<i32>,
    error: Option<String>,
}

enum ChatDispatchEvent {
    Attach,
    Line(String),
    Exit(ChatExit),
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn ai_chat_start<R: Runtime>(
    app: tauri::AppHandle<R>,
    sessions: tauri::State<'_, AiChatSessions>,
    answer_sessions: tauri::State<'_, CodexAnswerSessions>,
    request: AiChatStartRequest,
) -> Result<AiChatStartResponse, String> {
    let helper_executable = std::env::current_exe()
        .map_err(|error| format!("could not locate the app's MCP helper: {error}"))?;
    start_chat(
        app,
        sessions.inner().clone(),
        answer_sessions.inner().clone(),
        request,
        &helper_executable,
    )
}

// The helper executable is a parameter so the real-CLI test can point the MCP server at the
// built desktop binary, the test binary itself does not understand `--render-mcp`.
fn start_chat<R: Runtime>(
    app: tauri::AppHandle<R>,
    sessions: AiChatSessions,
    answer_sessions: CodexAnswerSessions,
    request: AiChatStartRequest,
    helper_executable: &Path,
) -> Result<AiChatStartResponse, String> {
    let session_id = validated_session_id(&request.session_id)?.to_string();
    validated_chat_provider(request.provider)?;
    let model = validated_model(request.model)?;
    let system_prompt_append = validated_system_prompt_append(&request.system_prompt_append)?;
    let repository_root = linked_repository_root(&request.repository_path)?;

    sessions.reserve(&session_id)?;
    let (render_socket, render_token) = match answer_sessions.start(
        app.clone(),
        &session_id,
        request.context,
        CHAT_ANSWER_PRESENTATION,
    ) {
        Ok(connection) => connection,
        Err(error) => {
            sessions.cancel_reservation(&session_id);
            return Err(error);
        }
    };

    let command = claude_chat_command(&ClaudeChatLaunch {
        repository_root: &repository_root,
        helper_executable,
        model: model.as_deref(),
        system_prompt_append,
        render_socket: &render_socket,
        render_token: &render_token,
    });
    let launched = launch_chat(
        app,
        sessions.clone(),
        answer_sessions.clone(),
        session_id.clone(),
        command,
        DEFAULT_PIPE_LIMITS,
    );
    if let Err(error) = launched {
        sessions.cancel_reservation(&session_id);
        answer_sessions.revoke(&session_id);
        return Err(error);
    }

    Ok(AiChatStartResponse { session_id })
}

#[tauri::command]
pub fn ai_chat_attach(
    sessions: tauri::State<'_, AiChatSessions>,
    request: AiChatSessionRequest,
) -> Result<(), String> {
    let session_id = validated_session_id(&request.session_id)?;
    sessions.attach(session_id)
}

// Send, interrupt and stop run off the main thread, so a slow stdin or the TERM/KILL grace cannot
// freeze the window. The per-session stdin mutex keeps every write whole and one at a time.
#[tauri::command(async)]
pub fn ai_chat_send(
    sessions: tauri::State<'_, AiChatSessions>,
    request: AiChatSendRequest,
) -> Result<(), String> {
    let session_id = validated_session_id(&request.session_id)?;
    let text = validated_user_text(&request.text)?;
    sessions.write_line(session_id, &user_turn_line(text))
}

#[tauri::command(async)]
pub fn ai_chat_interrupt(
    sessions: tauri::State<'_, AiChatSessions>,
    request: AiChatSessionRequest,
) -> Result<(), String> {
    let session_id = validated_session_id(&request.session_id)?;
    let request_id = next_interrupt_request_id();
    sessions.write_line(session_id, &interrupt_line(&request_id))
}

#[tauri::command(async)]
pub fn ai_chat_stop(
    sessions: tauri::State<'_, AiChatSessions>,
    request: AiChatSessionRequest,
) -> Result<(), String> {
    let session_id = validated_session_id(&request.session_id)?;
    sessions.with_session(session_id, |session| session.process.request_stop())
}

// ---------------------------------------------------------------------------------------------
// Validation and stdin lines (pure)
// ---------------------------------------------------------------------------------------------

fn validated_chat_provider(provider: TerminalProvider) -> Result<(), String> {
    if provider == TerminalProvider::Codex {
        return Err("the chat supports only Claude, use the terminal for Codex".into());
    }

    Ok(())
}

fn validated_system_prompt_append(text: &str) -> Result<&str, String> {
    if text.len() > MAX_SYSTEM_PROMPT_APPEND_BYTES || text.contains('\0') {
        return Err(format!(
            "chat system prompt must be at most {MAX_SYSTEM_PROMPT_APPEND_BYTES} bytes with no NUL"
        ));
    }

    Ok(text)
}

fn validated_user_text(text: &str) -> Result<&str, String> {
    if text.is_empty() || text.len() > MAX_USER_TEXT_BYTES {
        return Err(format!(
            "chat message must be 1-{MAX_USER_TEXT_BYTES} bytes"
        ));
    }

    Ok(text)
}

// serde_json escapes every newline inside the text, so one turn is always exactly one stdin line.
// Claude exits on a malformed stdin line, so this shape must never be built by concatenation.
fn user_turn_line(text: &str) -> String {
    let message = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": text },
    });
    format!("{message}\n")
}

// A stdin interrupt keeps the session alive. SIGINT would end the whole Claude process.
fn interrupt_line(request_id: &str) -> String {
    let request = serde_json::json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": "interrupt" },
    });
    format!("{request}\n")
}

fn next_interrupt_request_id() -> String {
    let number = NEXT_INTERRUPT_REQUEST.fetch_add(1, Ordering::Relaxed);
    format!("pr-visualizer-interrupt-{number}")
}

// ---------------------------------------------------------------------------------------------
// Claude argv
// ---------------------------------------------------------------------------------------------

struct ClaudeChatLaunch<'a> {
    repository_root: &'a Path,
    helper_executable: &'a Path,
    model: Option<&'a str>,
    system_prompt_append: &'a str,
    render_socket: &'a str,
    render_token: &'a str,
}

fn claude_chat_command(launch: &ClaudeChatLaunch<'_>) -> Command {
    let profile = claude_safety_profile(
        launch.helper_executable,
        launch.render_socket,
        launch.render_token,
        CHAT_ANSWER_PRESENTATION,
    );
    let mut command = Command::new("claude");
    command.args(["-p", "--input-format", "stream-json"]);
    // stream-json output under -p exits 1 unless --verbose is also given.
    command.args(["--output-format", "stream-json", "--verbose"]);
    command.arg("--include-partial-messages");
    // Load neither user nor project settings. The reviewer's own allow list and hooks would run
    // unprompted, and the repository under review could ship hooks with no trust dialog.
    command.args(["--setting-sources", ""]);
    command.arg("--strict-mcp-config");
    command.args(&profile.args);
    // The chat reads untrusted pull requests, so its built-in tools are an allowlist. `--tools`
    // limits only built-ins, the app's MCP tools stay available.
    command.args(["--tools", &CHAT_BUILT_IN_TOOLS.join(",")]);
    command.arg("--disable-slash-commands");
    // The chat has no approval UI, so anything that would need approval is denied.
    command.args(["--permission-prompts", "none"]);
    if let Some(model) = launch.model {
        command.args(["--model", model]);
    }
    if !launch.system_prompt_append.is_empty() {
        command.args(["--append-system-prompt", launch.system_prompt_append]);
    }

    command.current_dir(launch.repository_root);
    for name in profile.removed_env.iter().chain(CHAT_REMOVED_ENV) {
        command.env_remove(name);
    }
    for (name, value) in &profile.set_env {
        command.env(name, value);
    }
    command
}

// ---------------------------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------------------------

struct ChatSession {
    generation: u64,
    process: Arc<ChatProcess>,
    dispatch_sender: mpsc::SyncSender<ChatDispatchEvent>,
}

#[derive(Clone, Default)]
pub struct AiChatSessions {
    // `None` reserves an ID while its child is being spawned, so two concurrent starts for one
    // ID cannot spawn two children.
    sessions: Arc<Mutex<ChatSessionMap>>,
}

type ChatSessionMap = HashMap<String, Option<Arc<ChatSession>>>;

impl AiChatSessions {
    fn reserve(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.lock()?;
        if sessions.contains_key(session_id) {
            return Err("a chat session with this ID is already active".into());
        }

        sessions.insert(session_id.to_string(), None);
        Ok(())
    }

    fn activate(&self, session_id: &str, session: ChatSession) -> Result<(), String> {
        let mut sessions = self.lock()?;
        let reserved = sessions
            .get_mut(session_id)
            .ok_or_else(|| "chat start was cancelled".to_string())?;
        if reserved.is_some() {
            return Err("a chat session with this ID is already active".into());
        }

        *reserved = Some(Arc::new(session));
        Ok(())
    }

    fn cancel_reservation(&self, session_id: &str) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        if matches!(sessions.get(session_id), Some(None)) {
            sessions.remove(session_id);
        }
    }

    fn remove_generation(&self, session_id: &str, generation: u64) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        let is_same_session = matches!(
            sessions.get(session_id),
            Some(Some(session)) if session.generation == generation
        );
        if is_same_session {
            sessions.remove(session_id);
        }
    }

    fn with_session<T>(
        &self,
        session_id: &str,
        action: impl FnOnce(&ChatSession) -> Result<T, String>,
    ) -> Result<T, String> {
        let session = self
            .lock()?
            .get(session_id)
            .and_then(Option::as_ref)
            .cloned()
            .ok_or_else(|| "chat session is no longer active".to_string())?;

        action(&session)
    }

    fn attach(&self, session_id: &str) -> Result<(), String> {
        self.with_session(session_id, |session| {
            session
                .dispatch_sender
                .send(ChatDispatchEvent::Attach)
                .map_err(|_| "chat session is no longer active".to_string())
        })
    }

    fn write_line(&self, session_id: &str, line: &str) -> Result<(), String> {
        self.with_session(session_id, |session| session.process.write_line(line))
    }

    pub fn shutdown(&self) {
        let sessions = match self.sessions.lock() {
            Ok(mut sessions) => std::mem::take(&mut *sessions),
            Err(_) => return,
        };

        for session in sessions.into_values().flatten() {
            let _ = session.process.request_stop();
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ChatSessionMap>, String> {
        self.sessions
            .lock()
            .map_err(|_| "chat session state is unavailable".to_string())
    }
}

// Removing the session and revoking its answer socket happen in exactly one place. Taking `self`
// by value makes a second run a compile error.
struct SessionCleanup {
    sessions: AiChatSessions,
    answer_sessions: CodexAnswerSessions,
    session_id: String,
    generation: u64,
}

impl SessionCleanup {
    fn run(self) {
        self.sessions
            .remove_generation(&self.session_id, self.generation);
        self.answer_sessions.revoke(&self.session_id);
    }
}

// ---------------------------------------------------------------------------------------------
// Child process
// ---------------------------------------------------------------------------------------------

struct ChatProcess {
    // The waiter polls `try_wait` instead of blocking in `wait`, because a blocking wait would
    // hold the child and leave `kill` (the only stop on Windows) unreachable.
    child: Mutex<Child>,
    #[cfg(unix)]
    process_group: i32,
    stdin: Mutex<Option<ChildStdin>>,
    // The first failure wins. The waiter reads it once the child has exited.
    failure: Mutex<Option<String>>,
    stop_requested: AtomicBool,
}

impl ChatProcess {
    fn write_line(&self, line: &str) -> Result<(), String> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| "chat input is unavailable".to_string())?;
        let stdin = stdin
            .as_mut()
            .ok_or_else(|| "chat input is closed".to_string())?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|error| format!("could not write chat input: {error}"))
    }

    // Signal first. A send blocked on a full stdin pipe holds the stdin lock, and only ending the
    // child turns that write into EPIPE. Waiting for the lock first would hang stop and shutdown.
    fn request_stop(&self) -> Result<(), String> {
        self.stop_requested.store(true, Ordering::SeqCst);
        let stopped = self.terminate();
        self.close_stdin();
        stopped
    }

    fn fail(&self, reason: String) {
        if let Ok(mut failure) = self.failure.lock() {
            failure.get_or_insert(reason);
        }
        let _ = self.terminate();
    }

    // Never waits. A writer that still holds the lock fails on the closed pipe instead, and the
    // handle is dropped with the session.
    fn close_stdin(&self) {
        if let Ok(mut stdin) = self.stdin.try_lock() {
            stdin.take();
        }
    }

    #[cfg(unix)]
    fn terminate(&self) -> Result<(), String> {
        stop_process_group(self.process_group)
    }

    #[cfg(not(unix))]
    fn terminate(&self) -> Result<(), String> {
        self.child
            .lock()
            .map_err(|_| "chat process is unavailable".to_string())?
            .kill()
            .map_err(|error| format!("could not stop chat: {error}"))
    }

    fn wait_for_exit(&self) -> Result<ExitStatus, String> {
        loop {
            let status = self
                .child
                .lock()
                .map_err(|_| "chat process is unavailable".to_string())?
                .try_wait()
                .map_err(|error| format!("could not wait for Claude: {error}"))?;
            if let Some(status) = status {
                return Ok(status);
            }

            thread::sleep(EXIT_POLL_INTERVAL);
        }
    }

    fn failure(&self) -> Option<String> {
        self.failure.lock().ok().and_then(|failure| failure.clone())
    }
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn exit_signal(status: &ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_status: &ExitStatus) -> Option<i32> {
    None
}

fn launch_chat<R: Runtime>(
    app: tauri::AppHandle<R>,
    sessions: AiChatSessions,
    answer_sessions: CodexAnswerSessions,
    session_id: String,
    mut command: Command,
    limits: ChatPipeLimits,
) -> Result<(), String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start Claude: {error}"))?;
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("could not connect to Claude's input and output".into());
    };

    #[cfg(unix)]
    let process_group =
        i32::try_from(child.id()).map_err(|_| "Claude process ID is out of range".to_string())?;
    let process = Arc::new(ChatProcess {
        child: Mutex::new(child),
        #[cfg(unix)]
        process_group,
        stdin: Mutex::new(Some(stdin)),
        failure: Mutex::new(None),
        stop_requested: AtomicBool::new(false),
    });
    let generation = NEXT_SESSION_GENERATION.fetch_add(1, Ordering::Relaxed);
    let (dispatch_sender, dispatch_receiver) = mpsc::sync_channel(DISPATCH_QUEUE_CAPACITY);
    let session = ChatSession {
        generation,
        process: Arc::clone(&process),
        dispatch_sender: dispatch_sender.clone(),
    };
    if let Err(error) = sessions.activate(&session_id, session) {
        let _ = process.terminate();
        let _ = process.wait_for_exit();
        return Err(error);
    }

    let cleanup = SessionCleanup {
        sessions,
        answer_sessions,
        session_id: session_id.clone(),
        generation,
    };
    let dispatcher_process = Arc::clone(&process);
    thread::spawn(move || {
        run_dispatcher(app, cleanup, dispatch_receiver, &dispatcher_process, limits);
    });

    let stdout_sender = dispatch_sender.clone();
    let stdout_process = Arc::clone(&process);
    let stdout_thread = thread::spawn(move || {
        forward_stdout(stdout, limits, &stdout_sender, &stdout_process);
    });
    let stderr_thread = thread::spawn(move || read_stderr_tail(stderr));

    thread::spawn(move || {
        let status = process.wait_for_exit();
        // Descendants (the MCP helper, a tool command) can keep the pipes open after Claude
        // exits. Ending the group makes both readers finite, so the exit event always arrives.
        let _ = process.terminate();
        let _ = stdout_thread.join();
        let stderr_tail = stderr_thread.join().unwrap_or_default();
        let exit = chat_exit(status, &process, &stderr_tail);
        let _ = dispatch_sender.send(ChatDispatchEvent::Exit(exit));
    });

    Ok(())
}

fn chat_exit(status: Result<ExitStatus, String>, process: &ChatProcess, stderr: &str) -> ChatExit {
    let failure = process.failure();
    let stop_requested = process.stop_requested.load(Ordering::SeqCst);
    match status {
        Ok(status) => {
            let outcome = ExitOutcome {
                code: status.code(),
                signal: exit_signal(&status),
                failure,
                stop_requested,
            };
            ChatExit {
                code: outcome.code,
                error: exit_error(&outcome, stderr),
            }
        }
        Err(error) => ChatExit {
            code: None,
            error: Some(with_stderr(failure.unwrap_or(error), stderr)),
        },
    }
}

// ---------------------------------------------------------------------------------------------
// Exit reporting (pure)
// ---------------------------------------------------------------------------------------------

struct ExitOutcome {
    code: Option<i32>,
    signal: Option<i32>,
    failure: Option<String>,
    stop_requested: bool,
}

// A user stop is an expected end, even though it usually arrives as a signal. A pipe failure
// (an over-long line, a full startup buffer) is reported even when it caused the stop.
fn exit_error(outcome: &ExitOutcome, stderr: &str) -> Option<String> {
    if let Some(failure) = &outcome.failure {
        return Some(with_stderr(failure.clone(), stderr));
    }
    if outcome.stop_requested || outcome.code == Some(0) {
        return None;
    }

    let reason = match (outcome.code, outcome.signal) {
        (Some(code), _) => format!("Claude exited with code {code}"),
        (None, Some(signal)) => format!("Claude was stopped by signal {signal}"),
        (None, None) => "Claude exited without a status".to_string(),
    };
    Some(with_stderr(reason, stderr))
}

fn with_stderr(reason: String, stderr: &str) -> String {
    if stderr.is_empty() {
        return reason;
    }

    format!("{reason}: {stderr}")
}

// ---------------------------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------------------------

fn run_dispatcher<R: Runtime>(
    app: tauri::AppHandle<R>,
    cleanup: SessionCleanup,
    receiver: mpsc::Receiver<ChatDispatchEvent>,
    process: &ChatProcess,
    limits: ChatPipeLimits,
) {
    let session_id = cleanup.session_id.clone();
    let exit = forward_events(&app, &session_id, receiver, process, limits);
    // Clean up before the exit event, so a UI that restarts on exit can reuse the session ID.
    cleanup.run();

    let Some(exit) = exit else {
        return;
    };
    let event = AiChatExitEvent {
        session_id,
        code: exit.code,
        error: exit.error,
    };
    let _ = app.emit(EXIT_EVENT, event);
}

// Returns the exit to report, or `None` when every sender is gone before a listener attached
// (the session was shut down by a page reload or app exit).
fn forward_events<R: Runtime>(
    app: &tauri::AppHandle<R>,
    session_id: &str,
    receiver: mpsc::Receiver<ChatDispatchEvent>,
    process: &ChatProcess,
    limits: ChatPipeLimits,
) -> Option<ChatExit> {
    let mut attached = false;
    let mut discarding = false;
    let mut sequence = 0_u64;
    let mut buffered_lines = VecDeque::<String>::new();
    let mut buffered_bytes = 0_usize;
    let mut pending_exit: Option<ChatExit> = None;
    let mut emit_line = |line: String| {
        let event = AiChatLineEvent {
            session_id: session_id.to_string(),
            sequence,
            line,
        };
        let _ = app.emit(LINE_EVENT, event);
        sequence += 1;
    };

    while let Ok(event) = receiver.recv() {
        match event {
            ChatDispatchEvent::Attach if attached => {}
            ChatDispatchEvent::Attach => {
                attached = true;
                buffered_lines.drain(..).for_each(&mut emit_line);
                buffered_bytes = 0;
                if pending_exit.is_some() {
                    return pending_exit;
                }
            }
            ChatDispatchEvent::Line(_) if discarding => {}
            ChatDispatchEvent::Line(line) if attached => emit_line(line),
            ChatDispatchEvent::Line(line) => {
                if buffered_bytes.saturating_add(line.len()) <= limits.max_preattach_bytes {
                    buffered_bytes += line.len();
                    buffered_lines.push_back(line);
                    continue;
                }

                // Never drop or splice a transcript nobody is listening to yet. Stop the child
                // and report the failure once the chat attaches instead.
                discarding = true;
                buffered_lines.clear();
                buffered_bytes = 0;
                process.fail(format!(
                    "Claude output exceeded the {}-byte startup buffer before the chat attached",
                    limits.max_preattach_bytes
                ));
            }
            ChatDispatchEvent::Exit(exit) if attached => return Some(exit),
            // A stopped session will never be attached (the UI stops it when attach fails), and
            // the registry's sender would keep this loop alive forever, so finish now.
            ChatDispatchEvent::Exit(exit) if process.stop_requested.load(Ordering::SeqCst) => {
                return Some(exit)
            }
            ChatDispatchEvent::Exit(exit) => pending_exit = Some(exit),
        }
    }

    None
}

// ---------------------------------------------------------------------------------------------
// Pipe readers
// ---------------------------------------------------------------------------------------------

fn forward_stdout(
    stdout: impl Read,
    limits: ChatPipeLimits,
    sender: &mpsc::SyncSender<ChatDispatchEvent>,
    process: &ChatProcess,
) {
    let mut framer = LineFramer::new(limits.max_line_bytes);
    let read = read_lines(stdout, &mut framer, |line| {
        sender.send(ChatDispatchEvent::Line(line)).is_ok()
    });
    if let Err(reason) = read {
        process.fail(reason);
    }
}

// Calls `on_line` once per complete line, and once for a final line with no newline.
// `on_line` returns false to stop reading. An over-long line stops reading with an error.
fn read_lines(
    mut reader: impl Read,
    framer: &mut LineFramer,
    mut on_line: impl FnMut(String) -> bool,
) -> Result<(), String> {
    let mut chunk = vec![0_u8; READ_CHUNK_BYTES];
    loop {
        let count = match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        for line in framer.push(&chunk[..count])? {
            if !on_line(line) {
                return Ok(());
            }
        }
    }

    if let Some(line) = framer.finish() {
        on_line(line);
    }
    Ok(())
}

fn read_stderr_tail(mut stderr: impl Read) -> String {
    let mut tail = StderrTail::new(STDERR_TAIL_BYTES);
    let mut chunk = [0_u8; 4096];
    loop {
        match stderr.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => tail.push(&chunk[..count]),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }

    tail.text()
}

// ---------------------------------------------------------------------------------------------
// Framing (pure)
// ---------------------------------------------------------------------------------------------

struct LineFramer {
    pending: Vec<u8>,
    max_line_bytes: usize,
}

impl LineFramer {
    fn new(max_line_bytes: usize) -> Self {
        Self {
            pending: Vec::new(),
            max_line_bytes,
        }
    }

    // A line that would pass the cap fails the whole pipe, it is never cut or spliced.
    // Invalid UTF-8 is converted lossily, so a bad byte cannot crash the pipe.
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, String> {
        let mut lines = Vec::new();
        let mut rest = chunk;
        while let Some(newline) = rest.iter().position(|byte| *byte == b'\n') {
            self.extend_pending(&rest[..newline])?;
            let line = std::mem::take(&mut self.pending);
            if !line.is_empty() {
                lines.push(String::from_utf8_lossy(&line).into_owned());
            }
            rest = &rest[newline + 1..];
        }

        self.extend_pending(rest)?;
        Ok(lines)
    }

    fn finish(&mut self) -> Option<String> {
        let line = std::mem::take(&mut self.pending);
        if line.is_empty() {
            return None;
        }

        Some(String::from_utf8_lossy(&line).into_owned())
    }

    fn extend_pending(&mut self, bytes: &[u8]) -> Result<(), String> {
        if self.pending.len().saturating_add(bytes.len()) > self.max_line_bytes {
            self.pending.clear();
            return Err(format!(
                "a Claude output line exceeded the {}-byte limit",
                self.max_line_bytes
            ));
        }

        self.pending.extend_from_slice(bytes);
        Ok(())
    }
}

struct StderrTail {
    bytes: VecDeque<u8>,
    capacity: usize,
}

impl StderrTail {
    fn new(capacity: usize) -> Self {
        Self {
            bytes: VecDeque::with_capacity(capacity),
            capacity,
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        let kept = &chunk[chunk.len().saturating_sub(self.capacity)..];
        self.bytes.extend(kept);
        let overflow = self.bytes.len().saturating_sub(self.capacity);
        self.bytes.drain(..overflow);
    }

    // The tail can start in the middle of a UTF-8 character, lossy conversion keeps it readable.
    fn text(&self) -> String {
        let bytes: Vec<u8> = self.bytes.iter().copied().collect();
        String::from_utf8_lossy(&bytes).trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn rendered_args(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    // The values a variadic flag takes, up to the next flag.
    fn flag_values<'a>(args: &'a [String], flag: &str) -> Vec<&'a str> {
        let Some(index) = args.iter().position(|arg| arg == flag) else {
            return Vec::new();
        };
        args[index + 1..]
            .iter()
            .take_while(|arg| !arg.starts_with("--"))
            .map(String::as_str)
            .collect()
    }

    fn flag_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        let index = args.iter().position(|arg| arg == flag)?;
        args.get(index + 1).map(String::as_str)
    }

    fn chat_command_with(model: Option<&str>, system_prompt_append: &str) -> Command {
        claude_chat_command(&ClaudeChatLaunch {
            repository_root: Path::new("/tmp/linked-repository"),
            helper_executable: Path::new("/tmp/pr-visualizer"),
            model,
            system_prompt_append,
            render_socket: "/tmp/answer.sock",
            render_token: "token",
        })
    }

    #[test]
    fn chat_command_keeps_terminal_safety_flags_and_adds_isolation_flags() {
        // Arrange
        let render_socket = "/tmp/answer.sock";
        let render_token = "token";
        let helper_executable = Path::new("/tmp/pr-visualizer");
        let terminal_profile = claude_safety_profile(
            helper_executable,
            render_socket,
            render_token,
            CHAT_ANSWER_PRESENTATION,
        );

        // Act
        let command = chat_command_with(None, "");
        let args = rendered_args(&command);

        // Assert
        assert!(
            args.windows(terminal_profile.args.len())
                .any(|window| window == terminal_profile.args.as_slice()),
            "chat must carry the terminal's Claude safety arguments unchanged: {args:?}"
        );
        let expected_flag_values = [
            ("--input-format", "stream-json"),
            ("--output-format", "stream-json"),
            ("--setting-sources", ""),
            ("--permission-mode", "manual"),
            ("--permission-prompts", "none"),
            ("--tools", "Bash,Read,Grep,Glob"),
        ];
        for (flag, value) in expected_flag_values {
            assert_eq!(flag_value(&args, flag), Some(value), "{flag}: {args:?}");
        }
        for flag in [
            "-p",
            "--verbose",
            "--include-partial-messages",
            "--strict-mcp-config",
            "--disable-slash-commands",
        ] {
            assert!(args.iter().any(|arg| arg == flag), "{flag}: {args:?}");
        }
    }

    #[test]
    fn chat_command_blocks_edit_tools_and_preapproves_only_app_tools_and_sem_diff() {
        // Arrange
        let model = None;

        // Act
        let args = rendered_args(&chat_command_with(model, ""));

        // Assert
        let expected_disallowed = vec!["Edit", "Write", "NotebookEdit"];
        assert_eq!(flag_values(&args, "--disallowedTools"), expected_disallowed);
        let expected_allowed = vec!["mcp__pr_visualizer", "Bash(sem diff *)"];
        assert_eq!(flag_values(&args, "--allowedTools"), expected_allowed);
        let mcp_config: serde_json::Value =
            serde_json::from_str(flag_value(&args, "--mcp-config").expect("--mcp-config value"))
                .expect("--mcp-config is JSON");
        let expected_mcp_config = serde_json::json!({
            "mcpServers": {
                "pr_visualizer": {
                    "type": "stdio",
                    "command": "/tmp/pr-visualizer",
                    "args": ["--render-mcp"],
                    "env": {
                        "PR_VISUALIZER_RENDER_SOCKET": "/tmp/answer.sock",
                        "PR_VISUALIZER_RENDER_TOKEN": "token",
                        "PR_VISUALIZER_ANSWER_PRESENTATION": "inline",
                    },
                },
            },
        });
        assert_eq!(mcp_config, expected_mcp_config);
    }

    #[test]
    fn chat_command_runs_in_repo_with_render_env_and_without_nested_session_or_plugin_env() {
        // Arrange
        let expected_cwd = Path::new("/tmp/linked-repository");

        // Act
        let command = chat_command_with(None, "");
        let envs: Vec<(&OsStr, Option<&OsStr>)> = command.get_envs().collect();

        // Assert
        assert_eq!(command.get_current_dir(), Some(expected_cwd));
        for name in [
            "CLAUDE_CODE_CHILD_SESSION",
            "CLAUDECODE",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_CODE_PLUGIN_DIRS",
        ] {
            assert!(
                envs.contains(&(OsStr::new(name), None)),
                "{name} must be removed: {envs:?}"
            );
        }
        let expected_socket = (
            OsStr::new("PR_VISUALIZER_RENDER_SOCKET"),
            Some(OsStr::new("/tmp/answer.sock")),
        );
        assert!(envs.contains(&expected_socket), "{envs:?}");
    }

    #[test]
    fn chat_answers_show_inline_instead_of_in_a_window() {
        // Arrange
        let expected = AnswerPresentation::Inline;

        // Act
        let presentation = CHAT_ANSWER_PRESENTATION;

        // Assert
        assert_eq!(presentation, expected);
    }

    #[test]
    fn chat_command_omits_model_and_system_prompt_when_not_given() {
        // Arrange
        let model = None;
        let system_prompt_append = "";

        // Act
        let args = rendered_args(&chat_command_with(model, system_prompt_append));

        // Assert
        for flag in ["--model", "--append-system-prompt"] {
            assert!(!args.iter().any(|arg| arg == flag), "{flag}: {args:?}");
        }
    }

    #[test]
    fn chat_command_passes_model_and_system_prompt_when_given() {
        // Arrange
        let model = Some("opus");
        let system_prompt_append = "Answer with openui-lang blocks.";

        // Act
        let args = rendered_args(&chat_command_with(model, system_prompt_append));

        // Assert
        assert_eq!(flag_value(&args, "--model"), Some("opus"));
        assert_eq!(
            flag_value(&args, "--append-system-prompt"),
            Some(system_prompt_append)
        );
    }

    #[test]
    fn user_turn_is_one_json_line_even_with_newlines_quotes_and_non_ascii() {
        // Arrange
        let text = "line one\nline \"two\"\r\n☃ สวัสดี \\ end";

        // Act
        let line = user_turn_line(text);

        // Assert
        assert_eq!(line.matches('\n').count(), 1, "one line only: {line:?}");
        assert!(line.ends_with('\n'));
        let parsed: serde_json::Value = serde_json::from_str(&line).expect("valid JSON line");
        let expected = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": text },
        });
        assert_eq!(parsed, expected);
    }

    #[test]
    fn interrupt_line_is_a_control_request_with_a_unique_request_id() {
        // Arrange
        let first_id = next_interrupt_request_id();
        let second_id = next_interrupt_request_id();

        // Act
        let line = interrupt_line(&first_id);

        // Assert
        assert_ne!(first_id, second_id);
        assert_eq!(line.matches('\n').count(), 1);
        let parsed: serde_json::Value = serde_json::from_str(&line).expect("valid JSON line");
        let expected = serde_json::json!({
            "type": "control_request",
            "request_id": first_id,
            "request": { "subtype": "interrupt" },
        });
        assert_eq!(parsed, expected);
    }

    #[test]
    fn send_rejects_empty_and_oversized_text() {
        // Arrange
        let empty_text = "";
        let oversized_text = "a".repeat(MAX_USER_TEXT_BYTES + 1);
        let largest_text = "a".repeat(MAX_USER_TEXT_BYTES);

        // Act
        let empty = validated_user_text(empty_text);
        let oversized = validated_user_text(&oversized_text);
        let largest = validated_user_text(&largest_text);

        // Assert
        assert!(empty.is_err());
        assert!(oversized.is_err());
        assert!(largest.is_ok());
    }

    #[test]
    fn start_rejects_codex_provider_with_a_clear_message() {
        // Arrange
        let provider = TerminalProvider::Codex;

        // Act
        let result = validated_chat_provider(provider);

        // Assert
        let expected = "the chat supports only Claude, use the terminal for Codex";
        assert_eq!(result.expect_err("codex must be rejected"), expected);
    }

    #[test]
    fn shared_validators_name_no_single_surface() {
        // Arrange
        let invalid_session_id = "bad id";
        let invalid_model = Some(String::new());

        // Act
        let session_id_error = validated_session_id(invalid_session_id).expect_err("space");
        let model_error = validated_model(invalid_model).expect_err("empty model");

        // Assert
        let expected_session_id_error =
            "session ID may contain only letters, numbers, hyphens, and underscores";
        assert_eq!(session_id_error, expected_session_id_error);
        let expected_model_error = "model must be a non-empty string up to 128 characters";
        assert_eq!(model_error, expected_model_error);
    }

    #[test]
    fn start_rejects_oversized_system_prompt() {
        // Arrange
        let oversized_prompt = "a".repeat(MAX_SYSTEM_PROMPT_APPEND_BYTES + 1);

        // Act
        let result = validated_system_prompt_append(&oversized_prompt);

        // Assert
        assert!(result.is_err());
    }

    #[test]
    fn start_request_parses_the_contract_shape() {
        // Arrange
        let request = r#"{
            "sessionId": "chat-1",
            "provider": "claude",
            "repositoryPath": "/tmp/linked-repository",
            "model": null,
            "systemPromptAppend": "",
            "context": {
                "owner": "acme",
                "repo": "widgets",
                "number": 42,
                "title": "Add widgets",
                "baseSha": "base",
                "headSha": "head",
                "selectedFilePath": null
            }
        }"#;

        // Act
        let parsed = serde_json::from_str::<AiChatStartRequest>(request);

        // Assert
        let parsed = parsed.expect("contract request must parse");
        assert_eq!(parsed.provider, TerminalProvider::Claude);
        assert_eq!(parsed.model, None);
    }

    #[test]
    fn framer_emits_a_line_split_across_reads_once() {
        // Arrange
        let mut framer = LineFramer::new(1024);
        let first_read = br#"{"type":"stream_"#;
        let second_read = b"event\"}\n{\"type\":\"result\"}\n";

        // Act
        let first_lines = framer.push(first_read).expect("first read");
        let second_lines = framer.push(second_read).expect("second read");

        // Assert
        assert!(first_lines.is_empty());
        let expected = vec![
            r#"{"type":"stream_event"}"#.to_string(),
            r#"{"type":"result"}"#.to_string(),
        ];
        assert_eq!(second_lines, expected);
    }

    #[test]
    fn framer_fails_closed_on_an_over_long_line() {
        // Arrange
        let max_line_bytes = 8;
        let mut framer = LineFramer::new(max_line_bytes);
        let first_read = b"12345";
        let second_read = b"6789\n";

        // Act
        let first = framer.push(first_read);
        let second = framer.push(second_read);

        // Assert
        assert_eq!(first, Ok(Vec::new()));
        let expected = "a Claude output line exceeded the 8-byte limit";
        assert_eq!(second.expect_err("over-long line must fail"), expected);
    }

    #[test]
    fn framer_converts_invalid_utf8_lossily_and_flushes_a_final_unterminated_line() {
        // Arrange
        let mut framer = LineFramer::new(1024);
        let read = b"ok \xff\nlast";

        // Act
        let lines = framer.push(read).expect("read");
        let last = framer.finish();

        // Assert
        assert_eq!(lines, vec!["ok \u{fffd}".to_string()]);
        assert_eq!(last, Some("last".to_string()));
    }

    #[test]
    fn stderr_tail_keeps_only_the_last_bytes() {
        // Arrange
        let capacity = 4;
        let mut tail = StderrTail::new(capacity);

        // Act
        tail.push(b"abc");
        tail.push(b"defg");

        // Assert
        assert_eq!(tail.text(), "defg");
    }

    #[test]
    fn exit_error_is_empty_for_a_clean_exit_and_a_requested_stop() {
        // Arrange
        let clean = ExitOutcome {
            code: Some(0),
            signal: None,
            failure: None,
            stop_requested: false,
        };
        let stopped = ExitOutcome {
            code: None,
            signal: Some(15),
            failure: None,
            stop_requested: true,
        };
        let stderr = "noise";

        // Act
        let clean_error = exit_error(&clean, stderr);
        let stopped_error = exit_error(&stopped, stderr);

        // Assert
        assert_eq!(clean_error, None);
        assert_eq!(stopped_error, None);
    }

    #[test]
    fn exit_error_carries_the_stderr_tail_and_a_pipe_failure_wins() {
        // Arrange
        let crashed = ExitOutcome {
            code: Some(1),
            signal: None,
            failure: None,
            stop_requested: false,
        };
        let overflowed = ExitOutcome {
            code: None,
            signal: Some(15),
            failure: Some("a Claude output line exceeded the 8-byte limit".into()),
            stop_requested: false,
        };
        let stderr = "Error: Expected message role 'user'";

        // Act
        let crashed_error = exit_error(&crashed, stderr);
        let overflowed_error = exit_error(&overflowed, "");

        // Assert
        let expected_crash = "Claude exited with code 1: Error: Expected message role 'user'";
        assert_eq!(crashed_error.as_deref(), Some(expected_crash));
        let expected_overflow = "a Claude output line exceeded the 8-byte limit";
        assert_eq!(overflowed_error.as_deref(), Some(expected_overflow));
    }

    #[cfg(unix)]
    #[test]
    fn real_child_line_split_across_writes_is_read_once() {
        // Arrange
        let mut child = Command::new("/bin/sh")
            .args(["-c", r#"printf '{"a":'; sleep 0.2; printf '1}\n'"#])
            .stdout(Stdio::piped())
            .spawn()
            .expect("start printf fixture");
        let stdout = child.stdout.take().expect("piped stdout");
        let mut framer = LineFramer::new(1024);
        let mut lines = Vec::new();

        // Act
        let result = read_lines(stdout, &mut framer, |line| {
            lines.push(line);
            true
        });
        let _ = child.wait();

        // Assert
        assert_eq!(result, Ok(()));
        assert_eq!(lines, vec![r#"{"a":1}"#.to_string()]);
    }

    #[cfg(unix)]
    mod pipe {
        use super::*;
        use tauri::Listener;

        const EVENT_TIMEOUT: Duration = Duration::from_secs(5);

        struct ChatHarness {
            app: tauri::App<tauri::test::MockRuntime>,
            sessions: AiChatSessions,
            answer_sessions: CodexAnswerSessions,
            lines: mpsc::Receiver<serde_json::Value>,
            exits: mpsc::Receiver<serde_json::Value>,
        }

        fn forward_events_to(
            handle: &tauri::AppHandle<tauri::test::MockRuntime>,
            event: &str,
        ) -> mpsc::Receiver<serde_json::Value> {
            let (sender, receiver) = mpsc::channel();
            handle.listen(event, move |event| {
                if let Ok(payload) = serde_json::from_str(event.payload()) {
                    let _ = sender.send(payload);
                }
            });
            receiver
        }

        fn launch_shell_chat(
            session_id: &str,
            script: &str,
            limits: ChatPipeLimits,
        ) -> ChatHarness {
            let app = tauri::test::mock_app();
            let handle = app.handle().clone();
            let lines = forward_events_to(&handle, LINE_EVENT);
            let exits = forward_events_to(&handle, EXIT_EVENT);
            let sessions = AiChatSessions::default();
            let answer_sessions = CodexAnswerSessions::default();
            let mut command = Command::new("/bin/sh");
            command.args(["-c", script]);
            sessions.reserve(session_id).expect("reserve session");
            answer_sessions
                .start(
                    handle.clone(),
                    session_id,
                    fixture_answer_context(),
                    CHAT_ANSWER_PRESENTATION,
                )
                .expect("start answer session");
            launch_chat(
                handle,
                sessions.clone(),
                answer_sessions.clone(),
                session_id.to_string(),
                command,
                limits,
            )
            .expect("launch shell fixture");
            ChatHarness {
                app,
                sessions,
                answer_sessions,
                lines,
                exits,
            }
        }

        fn fixture_answer_context() -> CodexAnswerContext {
            serde_json::from_value(serde_json::json!({
                "owner": "acme",
                "repo": "widgets",
                "number": 42,
                "title": "Add widgets",
                "baseSha": "base",
                "headSha": "head",
                "selectedFilePath": null
            }))
            .expect("fixture context")
        }

        // An answer session ID can be started again only after the previous one was revoked.
        fn answer_session_was_revoked(harness: &ChatHarness, session_id: &str) -> bool {
            let restarted = harness.answer_sessions.start(
                harness.app.handle().clone(),
                session_id,
                fixture_answer_context(),
                CHAT_ANSWER_PRESENTATION,
            );
            if restarted.is_ok() {
                harness.answer_sessions.revoke(session_id);
            }
            restarted.is_ok()
        }

        fn wait_until(condition: impl Fn() -> bool) -> bool {
            let deadline = std::time::Instant::now() + EVENT_TIMEOUT;
            while std::time::Instant::now() < deadline {
                if condition() {
                    return true;
                }
                thread::sleep(Duration::from_millis(10));
            }
            condition()
        }

        fn stop_on_a_thread(
            sessions: &AiChatSessions,
            session_id: &str,
        ) -> mpsc::Receiver<Result<(), String>> {
            let (sender, receiver) = mpsc::channel();
            let sessions = sessions.clone();
            let session_id = session_id.to_string();
            thread::spawn(move || {
                let stopped =
                    sessions.with_session(&session_id, |session| session.process.request_stop());
                let _ = sender.send(stopped);
            });
            receiver
        }

        fn is_registered(sessions: &AiChatSessions, session_id: &str) -> bool {
            sessions.with_session(session_id, |_| Ok(())).is_ok()
        }

        #[test]
        fn sent_turn_reaches_the_child_and_its_line_comes_back_as_an_event() {
            // Arrange
            let session_id = "chat-echo";
            let harness = launch_shell_chat(session_id, "cat", DEFAULT_PIPE_LIMITS);
            let text = "hello\n☃";
            harness.sessions.attach(session_id).expect("attach");

            // Act
            harness
                .sessions
                .write_line(session_id, &user_turn_line(text))
                .expect("send turn");
            let line_event = harness.lines.recv_timeout(EVENT_TIMEOUT);
            harness
                .sessions
                .with_session(session_id, |session| session.process.request_stop())
                .expect("stop");
            let exit_event = harness.exits.recv_timeout(EVENT_TIMEOUT);

            // Assert
            let expected_line = serde_json::json!({
                "sessionId": session_id,
                "sequence": 0,
                "line": user_turn_line(text).trim_end(),
            });
            assert_eq!(line_event.expect("line event"), expected_line);
            let expected_exit = serde_json::json!({ "sessionId": session_id, "error": null });
            let exit_event = exit_event.expect("exit event");
            assert_eq!(exit_event["sessionId"], expected_exit["sessionId"]);
            assert_eq!(exit_event["error"], expected_exit["error"]);
            assert!(!is_registered(&harness.sessions, session_id));
        }

        #[test]
        fn stop_returns_and_reports_exit_while_a_send_is_blocked_on_a_full_stdin_pipe() {
            // Arrange
            let session_id = "chat-blocked-send";
            let harness = launch_shell_chat(session_id, "sleep 30", DEFAULT_PIPE_LIMITS);
            harness.sessions.attach(session_id).expect("attach");
            let oversized_turn = user_turn_line(&"a".repeat(MAX_USER_TEXT_BYTES));
            let (write_sender, write_receiver) = mpsc::channel();
            let writer_sessions = harness.sessions.clone();
            thread::spawn(move || {
                let written = writer_sessions.write_line(session_id, &oversized_turn);
                let _ = write_sender.send(written);
            });
            thread::sleep(Duration::from_millis(200));
            assert!(
                write_receiver.try_recv().is_err(),
                "the fixture must hold a write blocked on the full pipe"
            );

            // Act
            let stopped =
                stop_on_a_thread(&harness.sessions, session_id).recv_timeout(EVENT_TIMEOUT);
            let exit_event = harness.exits.recv_timeout(EVENT_TIMEOUT);
            let written = write_receiver.recv_timeout(EVENT_TIMEOUT);

            // Assert
            assert_eq!(stopped, Ok(Ok(())), "stop must return promptly");
            let exit_event = exit_event.expect("exit event after stop");
            assert_eq!(exit_event["error"], serde_json::Value::Null);
            assert!(
                matches!(written, Ok(Err(_))),
                "the blocked send must fail once the child is gone: {written:?}"
            );
        }

        #[test]
        fn stop_without_attach_unregisters_the_session_and_revokes_its_answer_session() {
            // Arrange
            let session_id = "chat-stop-unattached";
            let harness = launch_shell_chat(session_id, "sleep 30", DEFAULT_PIPE_LIMITS);

            // Act
            let stopped =
                stop_on_a_thread(&harness.sessions, session_id).recv_timeout(EVENT_TIMEOUT);
            let unregistered = wait_until(|| !is_registered(&harness.sessions, session_id));

            // Assert
            assert_eq!(stopped, Ok(Ok(())));
            assert!(
                unregistered,
                "a stopped, never-attached session must leave the registry"
            );
            assert!(
                answer_session_was_revoked(&harness, session_id),
                "its answer socket must be revoked"
            );
        }

        #[test]
        fn lines_printed_before_attach_are_flushed_in_order_on_attach() {
            // Arrange
            let session_id = "chat-preattach";
            let script = "printf 'one\\ntwo\\n'; exit 0";
            let harness = launch_shell_chat(session_id, script, DEFAULT_PIPE_LIMITS);
            thread::sleep(Duration::from_millis(300));

            // Act
            harness.sessions.attach(session_id).expect("attach");
            let first = harness.lines.recv_timeout(EVENT_TIMEOUT).expect("first");
            let second = harness.lines.recv_timeout(EVENT_TIMEOUT).expect("second");
            let exit_event = harness.exits.recv_timeout(EVENT_TIMEOUT).expect("exit");

            // Assert
            assert_eq!(
                (first["sequence"].clone(), first["line"].clone()),
                (0.into(), "one".into())
            );
            assert_eq!(
                (second["sequence"].clone(), second["line"].clone()),
                (1.into(), "two".into())
            );
            let expected_exit =
                serde_json::json!({ "sessionId": session_id, "code": 0, "error": null });
            assert_eq!(exit_event, expected_exit);
        }

        #[test]
        fn over_long_line_stops_the_child_and_reports_the_reason() {
            // Arrange
            let session_id = "chat-long-line";
            let limits = ChatPipeLimits {
                max_line_bytes: 16,
                max_preattach_bytes: 1024,
            };
            let script = "printf '%0100d\\n' 0; sleep 30";
            let harness = launch_shell_chat(session_id, script, limits);

            // Act
            harness.sessions.attach(session_id).expect("attach");
            let exit_event = harness.exits.recv_timeout(EVENT_TIMEOUT).expect("exit");

            // Assert
            let expected_error = "a Claude output line exceeded the 16-byte limit";
            assert_eq!(exit_event["error"], expected_error);
            assert!(
                harness.lines.try_recv().is_err(),
                "no partial line may be emitted"
            );
        }

        #[test]
        fn startup_buffer_overflow_stops_the_child_and_reports_on_attach() {
            // Arrange
            let session_id = "chat-preattach-overflow";
            let limits = ChatPipeLimits {
                max_line_bytes: 1024,
                max_preattach_bytes: 64,
            };
            let script = "i=0; while [ $i -lt 50 ]; do echo line-$i; i=$((i+1)); done; sleep 30";
            let harness = launch_shell_chat(session_id, script, limits);
            let has_failed = || {
                harness
                    .sessions
                    .with_session(session_id, |session| {
                        Ok(session.process.failure().is_some())
                    })
                    .unwrap_or(true)
            };
            let deadline = std::time::Instant::now() + EVENT_TIMEOUT;
            while !has_failed() && std::time::Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }

            // Act
            let _ = harness.sessions.attach(session_id);
            let exit_event = harness.exits.recv_timeout(EVENT_TIMEOUT).expect("exit");

            // Assert
            let expected_error =
                "Claude output exceeded the 64-byte startup buffer before the chat attached";
            assert_eq!(exit_event["error"], expected_error);
            assert!(
                harness.lines.try_recv().is_err(),
                "a cut transcript must not be emitted"
            );
        }
    }

    // Drives the real `claude` through the production command path. Ignored by default, because it
    // needs the installed CLI, a logged-in account and network.
    #[cfg(unix)]
    mod real_claude {
        use super::*;
        use std::fs::File;
        use std::path::PathBuf;
        use std::time::Instant;
        use tauri::{Listener, Manager};

        const TURN_TIMEOUT: Duration = Duration::from_secs(120);
        const EXIT_TIMEOUT: Duration = Duration::from_secs(10);
        const MARKER: &str = "ZXQ-7";

        struct Turn {
            lines: Vec<serde_json::Value>,
            elapsed: Duration,
        }

        impl Turn {
            fn result(&self) -> &serde_json::Value {
                self.lines.last().expect("a turn ends at its result line")
            }

            fn text_deltas(&self) -> Vec<&str> {
                self.lines.iter().filter_map(text_delta).collect()
            }

            fn has_permission_denial(&self) -> bool {
                let has_denied_line = self
                    .lines
                    .iter()
                    .any(|line| line["type"] == "system" && line["subtype"] == "permission_denied");
                let has_denial_entry = self.result()["permission_denials"]
                    .as_array()
                    .is_some_and(|denials| !denials.is_empty());
                has_denied_line || has_denial_entry
            }
        }

        fn text_delta(line: &serde_json::Value) -> Option<&str> {
            let event = &line["event"];
            let is_text_delta = line["type"] == "stream_event"
                && event["type"] == "content_block_delta"
                && event["delta"]["type"] == "text_delta";
            if !is_text_delta {
                return None;
            }

            event["delta"]["text"].as_str()
        }

        struct LiveChat {
            app: tauri::App<tauri::test::MockRuntime>,
            session_id: String,
            lines: mpsc::Receiver<String>,
            exits: mpsc::Receiver<serde_json::Value>,
            capture: Option<File>,
        }

        impl LiveChat {
            fn handle(&self) -> &tauri::AppHandle<tauri::test::MockRuntime> {
                self.app.handle()
            }

            fn send(&self, text: &str) {
                let request = AiChatSendRequest {
                    session_id: self.session_id.clone(),
                    text: text.to_string(),
                };
                ai_chat_send(self.handle().state(), request).expect("send a user turn");
            }

            // `on_line` sees every line of the turn as it arrives, so a test can act mid-turn.
            fn read_turn(&mut self, mut on_line: impl FnMut(&serde_json::Value)) -> Turn {
                let started = Instant::now();
                let deadline = started + TURN_TIMEOUT;
                let mut lines = Vec::new();
                loop {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    let raw = self
                        .lines
                        .recv_timeout(remaining)
                        .expect("the turn must reach its result line within 120 s");
                    if let Some(capture) = self.capture.as_mut() {
                        writeln!(capture, "{raw}").expect("write capture line");
                    }
                    let line: serde_json::Value =
                        serde_json::from_str(&raw).expect("every stdout line is JSON");
                    on_line(&line);
                    let is_result = line["type"] == "result";
                    lines.push(line);
                    if is_result {
                        return Turn {
                            lines,
                            elapsed: started.elapsed(),
                        };
                    }
                }
            }
        }

        fn claude_is_installed() -> bool {
            Command::new("claude")
                .arg("--version")
                .output()
                .is_ok_and(|output| output.status.success())
        }

        fn git(repository: &Path, args: &[&str]) {
            let status = Command::new("git")
                .arg("-C")
                .arg(repository)
                .args([
                    "-c",
                    "user.name=fixture",
                    "-c",
                    "user.email=fixture@example.invalid",
                ])
                .args(args)
                .status()
                .expect("run git");
            assert!(status.success(), "git {args:?} failed");
        }

        fn fixture_repository() -> PathBuf {
            let repository = std::env::temp_dir()
                .join(format!("pr-visualizer-ai-chat-live-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&repository);
            std::fs::create_dir_all(&repository).expect("create fixture repository");
            git(&repository, &["init", "-q"]);
            std::fs::write(repository.join("README.md"), "# Fixture\n").expect("write README");
            git(&repository, &["add", "README.md"]);
            git(&repository, &["commit", "-q", "-m", "init"]);
            repository
        }

        fn fixture_context() -> CodexAnswerContext {
            serde_json::from_value(serde_json::json!({
                "owner": "acme",
                "repo": "widgets",
                "number": 42,
                "title": "Add widgets",
                "baseSha": "base",
                "headSha": "head",
                "selectedFilePath": null
            }))
            .expect("fixture context")
        }

        fn forward_payloads<T: Send + 'static>(
            handle: &tauri::AppHandle<tauri::test::MockRuntime>,
            event: &str,
            map: impl Fn(serde_json::Value) -> Option<T> + Send + 'static,
        ) -> mpsc::Receiver<T> {
            let (sender, receiver) = mpsc::channel();
            handle.listen(event, move |event| {
                let payload = serde_json::from_str(event.payload()).ok().and_then(&map);
                if let Some(payload) = payload {
                    let _ = sender.send(payload);
                }
            });
            receiver
        }

        fn start_live_chat(repository: &Path, helper_executable: &Path) -> LiveChat {
            let app = tauri::test::mock_app();
            let handle = app.handle().clone();
            handle.manage(AiChatSessions::default());
            handle.manage(CodexAnswerSessions::default());
            let lines = forward_payloads(&handle, LINE_EVENT, |payload| {
                payload["line"].as_str().map(str::to_string)
            });
            let exits = forward_payloads(&handle, EXIT_EVENT, Some);
            let capture = std::env::var_os("AI_CHAT_CAPTURE_PATH")
                .map(|path| File::create(path).expect("create capture file"));
            let session_id = format!("live-chat-{}", std::process::id());
            let request = AiChatStartRequest {
                session_id: session_id.clone(),
                provider: TerminalProvider::Claude,
                repository_path: repository.to_string_lossy().into_owned(),
                model: Some("haiku".into()),
                system_prompt_append: format!("End every reply with the token {MARKER}."),
                context: fixture_context(),
            };

            start_chat(
                handle.clone(),
                handle.state::<AiChatSessions>().inner().clone(),
                handle.state::<CodexAnswerSessions>().inner().clone(),
                request,
                helper_executable,
            )
            .expect("start the real Claude chat");
            ai_chat_attach(
                handle.state(),
                AiChatSessionRequest {
                    session_id: session_id.clone(),
                },
            )
            .expect("attach");
            LiveChat {
                app,
                session_id,
                lines,
                exits,
                capture,
            }
        }

        // The test binary cannot serve `--render-mcp`, the built desktop binary can.
        fn built_desktop_binary() -> Option<PathBuf> {
            let binary = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/debug/pr-visualizer");
            binary.is_file().then_some(binary)
        }

        fn string_list(value: &serde_json::Value) -> Vec<String> {
            value
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .map(|item| match item.as_str() {
                            Some(text) => text.to_string(),
                            None => item.to_string(),
                        })
                        .collect()
                })
                .unwrap_or_default()
        }

        fn process_group_is_gone(process_group: i32) -> bool {
            let result = unsafe { libc::killpg(process_group, 0) };
            let error = std::io::Error::last_os_error().raw_os_error();
            // Darwin reports EPERM for a group whose last member awaits collection.
            result != 0 && matches!(error, Some(libc::ESRCH) | Some(libc::EPERM))
        }

        #[test]
        #[ignore = "requires the installed Claude CLI, user authentication and network"]
        fn real_claude_chat_answers_denies_writes_and_survives_an_interrupt() {
            // Arrange
            if !claude_is_installed() {
                eprintln!("skipping: `claude` is not on PATH");
                return;
            }
            let repository = fixture_repository();
            let denied_probe = repository.join("chat-denied-probe.txt");
            let desktop_binary = built_desktop_binary();
            let helper_executable = desktop_binary
                .clone()
                .unwrap_or_else(|| std::env::current_exe().expect("test executable"));
            let mut chat = start_live_chat(&repository, &helper_executable);
            let process_group = chat
                .handle()
                .state::<AiChatSessions>()
                .with_session(&chat.session_id, |session| {
                    Ok(session.process.process_group)
                })
                .expect("live session");

            // Act
            chat.send("Reply with the single word ok.");
            let answer_turn = chat.read_turn(|_| {});
            eprintln!("turn 1 (answer): {:?}", answer_turn.elapsed);

            chat.send("Run the shell command: touch chat-denied-probe.txt");
            let denied_turn = chat.read_turn(|_| {});
            eprintln!("turn 2 (denied write): {:?}", denied_turn.elapsed);

            chat.send("Write a 400 word essay about code review.");
            let interrupt_handle = chat.handle().clone();
            let interrupt_session_id = chat.session_id.clone();
            let mut interrupted = false;
            let interrupted_turn = chat.read_turn(|line| {
                if interrupted || text_delta(line).is_none() {
                    return;
                }
                interrupted = true;
                let request = AiChatSessionRequest {
                    session_id: interrupt_session_id.clone(),
                };
                ai_chat_interrupt(interrupt_handle.state(), request).expect("interrupt");
            });
            eprintln!("turn 3 (interrupted): {:?}", interrupted_turn.elapsed);

            chat.send("Reply with the single word ok.");
            let survived_turn = chat.read_turn(|_| {});
            eprintln!("turn 4 (after interrupt): {:?}", survived_turn.elapsed);

            let stop_request = AiChatSessionRequest {
                session_id: chat.session_id.clone(),
            };
            ai_chat_stop(chat.handle().state(), stop_request).expect("stop");
            let exit_event = chat.exits.recv_timeout(EXIT_TIMEOUT);
            let _ = std::fs::remove_dir_all(&repository);

            // Assert
            let init = answer_turn
                .lines
                .iter()
                .find(|line| line["type"] == "system" && line["subtype"] == "init")
                .expect("the first turn must carry an init line");
            let tools = string_list(&init["tools"]);
            eprintln!("init.tools: {tools:?}");
            eprintln!("init.mcp_servers: {}", init["mcp_servers"]);
            eprintln!("init.slash_commands: {}", init["slash_commands"]);
            eprintln!("init.skills: {}", init["skills"]);
            eprintln!("init.plugins: {}", init["plugins"]);
            let unexpected_tools: Vec<&String> = tools
                .iter()
                .filter(|tool| {
                    !CHAT_BUILT_IN_TOOLS.contains(&tool.as_str())
                        && !tool.starts_with("mcp__pr_visualizer__")
                })
                .collect();
            assert!(
                unexpected_tools.is_empty(),
                "only allowlisted and app MCP tools may load: {unexpected_tools:?}"
            );
            let slash_commands = string_list(&init["slash_commands"]);
            assert!(
                slash_commands.is_empty(),
                "slash commands still listed: {slash_commands:?}"
            );
            let skills = string_list(&init["skills"]);
            assert!(skills.is_empty(), "skills still listed: {skills:?}");
            let non_builtin_plugins: Vec<&serde_json::Value> = init["plugins"]
                .as_array()
                .map(|plugins| {
                    plugins
                        .iter()
                        .filter(|plugin| plugin["path"] != "builtin")
                        .collect()
                })
                .unwrap_or_default();
            assert!(
                non_builtin_plugins.is_empty(),
                "only the CLI's built-in plugins may load: {non_builtin_plugins:?}"
            );
            if desktop_binary.is_some() {
                let app_server = init["mcp_servers"]
                    .as_array()
                    .and_then(|servers| {
                        servers
                            .iter()
                            .find(|server| server["name"] == "pr_visualizer")
                    })
                    .expect("the app MCP server must be listed");
                assert_eq!(app_server["status"], "connected");
                assert!(
                    tools
                        .iter()
                        .any(|tool| tool.starts_with("mcp__pr_visualizer__")),
                    "--tools must not remove the app's MCP tools: {tools:?}"
                );
            } else {
                eprintln!(
                    "note: target/debug/pr-visualizer is missing, MCP connection not checked"
                );
            }

            let answer_text = answer_turn.text_deltas().concat();
            assert_eq!(answer_turn.result()["subtype"], "success");
            assert!(
                !answer_turn.text_deltas().is_empty(),
                "reply must stream text deltas"
            );
            assert!(
                answer_text.contains(MARKER),
                "the appended system prompt must reach the CLI: {answer_text:?}"
            );

            assert!(
                denied_turn.has_permission_denial(),
                "the shell write must be denied: {:?}",
                denied_turn.result()
            );
            assert!(
                !denied_probe.exists(),
                "a denied write must not create the file"
            );

            assert!(
                interrupted,
                "the essay turn must stream a text delta to interrupt"
            );
            assert_eq!(
                interrupted_turn.result()["subtype"],
                "error_during_execution"
            );
            assert_eq!(survived_turn.result()["subtype"], "success");
            assert!(
                !survived_turn.text_deltas().is_empty(),
                "the session must still answer after an interrupt"
            );

            let exit_event = exit_event.expect("exit event after stop");
            assert_eq!(exit_event["error"], serde_json::Value::Null);
            assert!(
                process_group_is_gone(process_group),
                "no child of the chat may be left running"
            );
        }
    }
}
