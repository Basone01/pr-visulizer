// The interactive terminal intentionally has a different boundary from the old safe-profile
// broker. It starts the user's installed Codex in their linked checkout, where Codex can inspect
// the PR locally. The CLI's read-only sandbox remains the enforcement point for model commands.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use tauri::{Emitter, Runtime};

use crate::codex_answer::{CodexAnswerContext, CodexAnswerSessions};

const MAX_SESSION_ID_LENGTH: usize = 128;
const MAX_MODEL_LENGTH: usize = 128;
const MAX_INITIAL_PROMPT_BYTES: usize = 64 * 1024;
const MAX_TERMINAL_COLUMNS: u16 = 500;
const MAX_TERMINAL_ROWS: u16 = 200;
const MAX_PREATTACH_OUTPUT_BYTES: usize = 1024 * 1024;
const DISPATCH_QUEUE_CAPACITY: usize = 64;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TerminalProvider {
    Codex,
    Claude,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTerminalStartRequest {
    pub session_id: String,
    pub provider: TerminalProvider,
    pub repository_path: String,
    pub initial_prompt: String,
    pub model: Option<String>,
    pub rows: u16,
    pub cols: u16,
    pub context: CodexAnswerContext,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTerminalWriteRequest {
    pub session_id: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTerminalResizeRequest {
    pub session_id: String,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTerminalSessionRequest {
    pub session_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTerminalStartResponse {
    pub session_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexTerminalOutputEvent {
    session_id: String,
    sequence: u64,
    data: Vec<u8>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexTerminalExitEvent {
    session_id: String,
    code: Option<u32>,
    error: Option<String>,
}

enum TerminalDispatchEvent {
    Attach,
    Output(Vec<u8>),
    Exit {
        code: Option<u32>,
        error: Option<String>,
    },
}

struct TerminalSession {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    killer: Arc<Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>>,
    process_group: Option<i32>,
    dispatch_sender: mpsc::SyncSender<TerminalDispatchEvent>,
}

#[derive(Clone, Default)]
pub struct CodexTerminalSessions {
    // `None` reserves an ID while its PTY is being created. This prevents two concurrent start
    // calls from spawning separate children for one requested terminal identity.
    sessions: Arc<Mutex<HashMap<String, Option<Arc<TerminalSession>>>>>,
}

impl CodexTerminalSessions {
    fn reserve(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "terminal session state is unavailable".to_string())?;
        if sessions.contains_key(session_id) {
            return Err("a terminal session with this ID is already active".into());
        }

        sessions.insert(session_id.to_string(), None);
        Ok(())
    }

    fn activate(&self, session_id: &str, session: TerminalSession) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "terminal session state is unavailable".to_string())?;
        let reserved = sessions
            .get_mut(session_id)
            .ok_or_else(|| "terminal start was cancelled".to_string())?;
        if reserved.is_some() {
            return Err("a terminal session with this ID is already active".into());
        }

        *reserved = Some(Arc::new(session));
        Ok(())
    }

    fn with_session<T>(
        &self,
        session_id: &str,
        action: impl FnOnce(&TerminalSession) -> Result<T, String>,
    ) -> Result<T, String> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "terminal session state is unavailable".to_string())?
            .get(session_id)
            .and_then(Option::as_ref)
            .cloned()
            .ok_or_else(|| "terminal session is no longer active".to_string())?;

        action(&session)
    }

    fn remove(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(session_id);
        }
    }

    pub fn shutdown(&self) {
        let sessions = match self.sessions.lock() {
            Ok(mut sessions) => std::mem::take(&mut *sessions),
            Err(_) => return,
        };

        for session in sessions.into_values().flatten() {
            let _ = stop_terminal_process(&session.killer, session.process_group);
        }
    }
}

#[cfg(unix)]
fn terminal_process_group_exists(process_group: i32) -> Result<bool, String> {
    let result = unsafe { libc::killpg(process_group, 0) };
    if result == 0 {
        return Ok(true);
    }

    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(false);
    }
    // Darwin can report EPERM for a process group whose only remaining member awaits collection.
    // This terminal owns the session group, so there is no unrelated process to preserve here.
    #[cfg(target_os = "macos")]
    if error.raw_os_error() == Some(libc::EPERM) {
        return Ok(false);
    }

    Err(format!("could not inspect terminal process group: {error}"))
}

#[cfg(unix)]
fn wait_for_terminal_process_group_exit(
    process_group: i32,
    timeout: std::time::Duration,
) -> Result<bool, String> {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if !terminal_process_group_exists(process_group)? {
            return Ok(true);
        }
        thread::sleep(std::time::Duration::from_millis(10));
    }

    terminal_process_group_exists(process_group).map(|exists| !exists)
}

#[cfg(unix)]
fn signal_terminal_process_group(process_group: i32, signal: i32) -> Result<(), String> {
    let result = unsafe { libc::killpg(process_group, signal) };
    if result == 0 {
        return Ok(());
    }

    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    if error.raw_os_error() == Some(libc::EPERM) {
        return Ok(());
    }

    Err(format!("could not signal terminal process group: {error}"))
}

#[cfg(unix)]
fn stop_terminal_process(
    killer: &Arc<Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>>,
    process_group: Option<i32>,
) -> Result<(), String> {
    let Some(process_group) = process_group else {
        return killer
            .lock()
            .map_err(|_| "terminal process is unavailable".to_string())?
            .kill()
            .map_err(|error| format!("could not stop terminal: {error}"));
    };

    signal_terminal_process_group(process_group, libc::SIGTERM)?;
    if wait_for_terminal_process_group_exit(process_group, std::time::Duration::from_millis(250))? {
        return Ok(());
    }

    signal_terminal_process_group(process_group, libc::SIGKILL)?;
    if wait_for_terminal_process_group_exit(process_group, std::time::Duration::from_secs(1))? {
        return Ok(());
    }

    Err("terminal process group remained alive after SIGKILL".into())
}

#[cfg(not(unix))]
fn stop_terminal_process(
    killer: &Arc<Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>>,
    _process_group: Option<i32>,
) -> Result<(), String> {
    killer
        .lock()
        .map_err(|_| "terminal process is unavailable".to_string())?
        .kill()
        .map_err(|error| format!("could not stop terminal: {error}"))
}

fn validated_session_id(session_id: &str) -> Result<&str, String> {
    if session_id.is_empty() || session_id.len() > MAX_SESSION_ID_LENGTH {
        return Err("terminal session ID must be 1-128 characters".into());
    }
    if !session_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(
            "terminal session ID may contain only letters, numbers, hyphens, and underscores"
                .into(),
        );
    }

    Ok(session_id)
}

fn validated_model(model: Option<String>) -> Result<Option<String>, String> {
    let Some(model) = model else {
        return Ok(None);
    };
    if model.is_empty() || model.len() > MAX_MODEL_LENGTH || model.contains('\0') {
        return Err("terminal model must be a non-empty string up to 128 characters".into());
    }

    Ok(Some(model))
}

fn validated_terminal_size(rows: u16, cols: u16) -> Result<PtySize, String> {
    if rows == 0 || rows > MAX_TERMINAL_ROWS || cols == 0 || cols > MAX_TERMINAL_COLUMNS {
        return Err("terminal size is outside the supported range".into());
    }

    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn linked_repository_root(path: &str) -> Result<PathBuf, String> {
    let requested = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("linked repository is not accessible: {error}"))?;
    if !requested.is_dir() {
        return Err("linked repository is not a directory".into());
    }

    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(&requested)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|error| format!("could not validate linked repository: {error}"))?;
    if !output.status.success() {
        return Err("linked repository is not a Git working tree".into());
    }

    let root = String::from_utf8(output.stdout)
        .map_err(|_| "Git returned a non-UTF-8 repository path".to_string())?;
    Path::new(root.trim())
        .canonicalize()
        .map_err(|error| format!("linked repository root is not accessible: {error}"))
}

fn codex_command(
    repository_root: &Path,
    model: Option<&str>,
    initial_prompt: &str,
    render_socket: &str,
    render_token: &str,
) -> CommandBuilder {
    let mut command = CommandBuilder::new("codex");
    let executable = std::env::current_exe()
        .expect("desktop executable path must be available to launch the MCP helper");
    let executable = executable.to_string_lossy();
    let command_config = format!(
        "mcp_servers.pr_visualizer.command = {}",
        serde_json::to_string(&executable.as_ref()).expect("executable path must serialize")
    );
    command.arg("-c");
    command.arg(command_config);
    command.arg("-c");
    command.arg("mcp_servers.pr_visualizer.args = [\"--render-mcp\"]");
    command.arg("-c");
    command.arg("mcp_servers.pr_visualizer.env_vars = [\"PR_VISUALIZER_RENDER_SOCKET\", \"PR_VISUALIZER_RENDER_TOKEN\"]");
    command.arg("-c");
    command.arg("mcp_servers.pr_visualizer.default_tools_approval_mode = \"approve\"");
    command.arg("--sandbox");
    command.arg("read-only");
    if let Some(model) = model {
        command.arg("--model");
        command.arg(model);
    }
    // Keep the transcript in the terminal's scrollback instead of letting Codex switch to an
    // alternate screen that would disappear from the embedded terminal when it exits.
    command.arg("--no-alt-screen");
    command.arg(initial_prompt);
    command.cwd(repository_root);
    command.env("PR_VISUALIZER_RENDER_SOCKET", render_socket);
    command.env("PR_VISUALIZER_RENDER_TOKEN", render_token);
    command
}

// Claude has no read-only OS sandbox flag like Codex's. The posture is: editing tools removed,
// every other mutation goes through the CLI's own interactive permission prompt.
fn claude_command(
    repository_root: &Path,
    model: Option<&str>,
    initial_prompt: &str,
    render_socket: &str,
    render_token: &str,
) -> CommandBuilder {
    let mut command = CommandBuilder::new("claude");
    let executable = std::env::current_exe()
        .expect("desktop executable path must be available to launch the MCP helper");
    let mcp_config = serde_json::json!({
        "mcpServers": {
            "pr_visualizer": {
                "type": "stdio",
                "command": executable.to_string_lossy(),
                "args": ["--render-mcp"],
                "env": {
                    "PR_VISUALIZER_RENDER_SOCKET": render_socket,
                    "PR_VISUALIZER_RENDER_TOKEN": render_token,
                },
            },
        },
    });
    command.arg("--mcp-config");
    command.arg(mcp_config.to_string());
    // Server-wide allow rule, so the app's own MCP tools never interrupt the session,
    // matching Codex's `default_tools_approval_mode = "approve"`. `sem diff` is pre-approved
    // because every flag it has only changes output format or filtering (checked 2026-10-14).
    // No git rule is pre-approved: `git diff --output` / `--ext-diff` could write files or run
    // programs.
    command.arg("--allowedTools");
    command.arg("mcp__pr_visualizer");
    command.arg("Bash(sem diff *)");
    command.arg("--disallowedTools");
    command.arg("Edit");
    command.arg("Write");
    command.arg("NotebookEdit");
    // Newer CLIs start interactive sessions in `auto` mode, so prompt-on-first-use must be explicit.
    command.arg("--permission-mode");
    command.arg("manual");
    if let Some(model) = model {
        command.arg("--model");
        command.arg(model);
    }
    command.arg(initial_prompt);
    command.cwd(repository_root);
    // Keep the transcript in the terminal's scrollback instead of an alternate screen.
    // Claude has no CLI flag for this, the env var forces the classic renderer.
    command.env("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN", "1");
    // When the desktop app itself was launched from inside a Claude Code session (dev),
    // the child would inherit the nested-session markers and run with transcript saving off.
    command.env_remove("CLAUDE_CODE_CHILD_SESSION");
    command.env_remove("CLAUDECODE");
    command.env_remove("CLAUDE_CODE_ENTRYPOINT");
    command.env("PR_VISUALIZER_RENDER_SOCKET", render_socket);
    command.env("PR_VISUALIZER_RENDER_TOKEN", render_token);
    command
}

fn emit_output<R: Runtime>(app: &tauri::AppHandle<R>, event: CodexTerminalOutputEvent) {
    let _ = app.emit("codex-terminal://output", event);
}

fn emit_exit<R: Runtime>(app: &tauri::AppHandle<R>, event: CodexTerminalExitEvent) {
    let _ = app.emit("codex-terminal://exit", event);
}

fn dispatch_terminal_events<R: Runtime>(
    app: tauri::AppHandle<R>,
    sessions: CodexTerminalSessions,
    session_id: String,
    receiver: mpsc::Receiver<TerminalDispatchEvent>,
    killer: Arc<Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>>,
    process_group: Option<i32>,
    answer_sessions: CodexAnswerSessions,
) {
    let mut attached = false;
    let mut sequence = 0_u64;
    let mut buffered_output = VecDeque::<Vec<u8>>::new();
    let mut buffered_bytes = 0_usize;
    let mut terminal: Option<(Option<u32>, Option<String>)> = None;

    while let Ok(event) = receiver.recv() {
        match event {
            TerminalDispatchEvent::Attach if !attached => {
                attached = true;
                while let Some(data) = buffered_output.pop_front() {
                    emit_output(
                        &app,
                        CodexTerminalOutputEvent {
                            session_id: session_id.clone(),
                            sequence,
                            data,
                        },
                    );
                    sequence += 1;
                }
                buffered_bytes = 0;

                if let Some((code, error)) = terminal.take() {
                    emit_exit(
                        &app,
                        CodexTerminalExitEvent {
                            session_id: session_id.clone(),
                            code,
                            error,
                        },
                    );
                    sessions.remove(&session_id);
                    answer_sessions.revoke(&session_id);
                    return;
                }
            }
            TerminalDispatchEvent::Attach => {}
            TerminalDispatchEvent::Output(_data) if terminal.is_some() => {}
            TerminalDispatchEvent::Output(data) if attached => {
                emit_output(
                    &app,
                    CodexTerminalOutputEvent {
                        session_id: session_id.clone(),
                        sequence,
                        data,
                    },
                );
                sequence += 1;
            }
            TerminalDispatchEvent::Output(data) => {
                if buffered_bytes.saturating_add(data.len()) <= MAX_PREATTACH_OUTPUT_BYTES {
                    buffered_bytes += data.len();
                    buffered_output.push_back(data);
                    continue;
                }

                // Do not drop or splice a transcript when no listener is attached. Stop the
                // child and report an explicit terminal failure after the UI attaches instead.
                let _ = stop_terminal_process(&killer, process_group);
                buffered_output.clear();
                buffered_bytes = 0;
                terminal = Some((
                    None,
                    Some(
                        "terminal output exceeded the 1 MiB startup buffer before it attached"
                            .into(),
                    ),
                ));
            }
            TerminalDispatchEvent::Exit { code, error } => {
                if attached {
                    emit_exit(
                        &app,
                        CodexTerminalExitEvent {
                            session_id: session_id.clone(),
                            code,
                            error,
                        },
                    );
                    sessions.remove(&session_id);
                    answer_sessions.revoke(&session_id);
                    return;
                }

                terminal = Some((code, error));
            }
        }
    }
}

fn launch_terminal<R: Runtime>(
    app: tauri::AppHandle<R>,
    sessions: CodexTerminalSessions,
    session_id: String,
    command: CommandBuilder,
    size: PtySize,
    answer_sessions: CodexAnswerSessions,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|error| format!("could not create terminal: {error}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("could not read terminal output: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("could not write terminal input: {error}"))?;
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("could not start terminal: {error}"))?;
    #[cfg(unix)]
    let process_group = child
        .process_id()
        .and_then(|pid| i32::try_from(pid).ok())
        .or_else(|| pair.master.process_group_leader());
    #[cfg(not(unix))]
    let process_group = None;
    let killer = Arc::new(Mutex::new(child.clone_killer()));
    let master = Arc::new(Mutex::new(pair.master));
    let (dispatch_sender, dispatch_receiver) = mpsc::sync_channel(DISPATCH_QUEUE_CAPACITY);

    let session = TerminalSession {
        writer: Arc::new(Mutex::new(writer)),
        master,
        killer: Arc::clone(&killer),
        process_group,
        dispatch_sender: dispatch_sender.clone(),
    };
    if let Err(error) = sessions.activate(&session_id, session) {
        if let Ok(mut killer) = killer.lock() {
            let _ = killer.kill();
        }
        return Err(error);
    }

    let dispatcher_sessions = sessions.clone();
    let dispatcher_session_id = session_id.clone();
    let dispatcher_killer = Arc::clone(&killer);
    thread::spawn(move || {
        dispatch_terminal_events(
            app,
            dispatcher_sessions,
            dispatcher_session_id,
            dispatch_receiver,
            dispatcher_killer,
            process_group,
            answer_sessions,
        );
    });

    let reader_sender = dispatch_sender.clone();
    let reader_thread = thread::spawn(move || {
        let mut reader = reader;
        let mut chunk = [0_u8; 8192];
        loop {
            let count = match reader.read(&mut chunk) {
                Ok(0) => return,
                Ok(count) => count,
                Err(_) => return,
            };
            if reader_sender
                .send(TerminalDispatchEvent::Output(chunk[..count].to_vec()))
                .is_err()
            {
                return;
            }
        }
    });

    let waiter_killer = Arc::clone(&killer);
    thread::spawn(move || {
        let status = child.wait();
        // A nested tool may retain the slave PTY after Codex exits. Closing its process group
        // first makes the output reader finite and guarantees a terminal event reaches the UI.
        let _ = stop_terminal_process(&waiter_killer, process_group);
        let _ = reader_thread.join();
        let event = match status {
            Ok(status) => TerminalDispatchEvent::Exit {
                code: Some(status.exit_code()),
                error: status.signal().map(str::to_string),
            },
            Err(error) => TerminalDispatchEvent::Exit {
                code: None,
                error: Some(format!("terminal did not exit cleanly: {error}")),
            },
        };
        let _ = dispatch_sender.send(event);
    });

    Ok(())
}

#[tauri::command]
pub fn codex_terminal_start<R: Runtime>(
    app: tauri::AppHandle<R>,
    sessions: tauri::State<'_, CodexTerminalSessions>,
    answer_sessions: tauri::State<'_, CodexAnswerSessions>,
    request: CodexTerminalStartRequest,
) -> Result<CodexTerminalStartResponse, String> {
    let session_id = validated_session_id(&request.session_id)?.to_string();
    let provider = request.provider;
    if request.initial_prompt.is_empty() || request.initial_prompt.len() > MAX_INITIAL_PROMPT_BYTES
    {
        return Err("terminal initial prompt must be 1-65536 bytes".into());
    }

    let model = validated_model(request.model)?;
    let size = validated_terminal_size(request.rows, request.cols)?;
    let repository_root = linked_repository_root(&request.repository_path)?;
    let sessions = sessions.inner().clone();
    sessions.reserve(&session_id)?;
    let answer_sessions = answer_sessions.inner().clone();
    let (render_socket, render_token) =
        match answer_sessions.start(app.clone(), &session_id, request.context) {
            Ok(connection) => connection,
            Err(error) => {
                sessions.remove(&session_id);
                return Err(error);
            }
        };
    let build_command = match provider {
        TerminalProvider::Codex => codex_command,
        TerminalProvider::Claude => claude_command,
    };
    let command = build_command(
        &repository_root,
        model.as_deref(),
        &request.initial_prompt,
        &render_socket,
        &render_token,
    );

    if let Err(error) = launch_terminal(
        app,
        sessions.clone(),
        session_id.clone(),
        command,
        size,
        answer_sessions.clone(),
    ) {
        sessions.remove(&session_id);
        answer_sessions.revoke(&session_id);
        return Err(error);
    }

    Ok(CodexTerminalStartResponse { session_id })
}

#[tauri::command]
pub fn codex_terminal_attach(
    sessions: tauri::State<'_, CodexTerminalSessions>,
    request: CodexTerminalSessionRequest,
) -> Result<(), String> {
    let session_id = validated_session_id(&request.session_id)?;
    sessions.with_session(session_id, |session| {
        session
            .dispatch_sender
            .send(TerminalDispatchEvent::Attach)
            .map_err(|_| "terminal session is no longer active".to_string())
    })
}

#[tauri::command]
pub fn codex_terminal_write(
    sessions: tauri::State<'_, CodexTerminalSessions>,
    request: CodexTerminalWriteRequest,
) -> Result<(), String> {
    let session_id = validated_session_id(&request.session_id)?;
    if request.data.len() > 64 * 1024 {
        return Err("terminal input is limited to 64 KiB per write".into());
    }

    sessions.with_session(session_id, |session| {
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| "terminal input is unavailable".to_string())?;
        writer
            .write_all(&request.data)
            .and_then(|_| writer.flush())
            .map_err(|error| format!("could not write terminal input: {error}"))
    })
}

#[tauri::command]
pub fn codex_terminal_resize(
    sessions: tauri::State<'_, CodexTerminalSessions>,
    request: CodexTerminalResizeRequest,
) -> Result<(), String> {
    let session_id = validated_session_id(&request.session_id)?;
    let size = validated_terminal_size(request.rows, request.cols)?;

    sessions.with_session(session_id, |session| {
        session
            .master
            .lock()
            .map_err(|_| "terminal display is unavailable".to_string())?
            .resize(size)
            .map_err(|error| format!("could not resize terminal: {error}"))
    })
}

#[tauri::command]
pub fn codex_terminal_stop(
    sessions: tauri::State<'_, CodexTerminalSessions>,
    request: CodexTerminalSessionRequest,
) -> Result<(), String> {
    let session_id = validated_session_id(&request.session_id)?;
    sessions.with_session(session_id, |session| {
        stop_terminal_process(&session.killer, session.process_group)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_size_rejects_invalid_dimensions() {
        // Arrange
        let rows = 0;
        let cols = 80;

        // Act
        let result = validated_terminal_size(rows, cols);

        // Assert
        assert_eq!(
            result.expect_err("zero rows must fail"),
            "terminal size is outside the supported range"
        );
    }

    #[test]
    fn pty_round_trips_input_utf8_and_resize() {
        // Arrange
        let pty_system = native_pty_system();
        let initial_size = PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system.openpty(initial_size).expect("open a real pty");
        let command = CommandBuilder::new("/bin/cat");
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("start shell fixture");
        let mut reader = pair.master.try_clone_reader().expect("clone pty reader");
        let mut writer = pair.master.take_writer().expect("take pty writer");
        let resized = PtySize {
            rows: 40,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        };
        let (output_sender, output_receiver) = mpsc::sync_channel(1);
        let expected_echo = "snowman ☃".as_bytes().to_vec();

        // Act
        pair.master.resize(resized).expect("resize pty");
        thread::spawn(move || {
            let mut output = Vec::new();
            let mut chunk = [0_u8; 256];
            while !output
                .windows(expected_echo.len())
                .any(|bytes| bytes == expected_echo)
            {
                let count = reader.read(&mut chunk).expect("read pty output");
                if count == 0 {
                    break;
                }
                output.extend_from_slice(&chunk[..count]);
            }
            let _ = output_sender.send(output);
        });
        writer
            .write_all("snowman ☃\r".as_bytes())
            .expect("write input");
        writer.flush().expect("flush input");
        let output = output_receiver.recv_timeout(std::time::Duration::from_secs(2));
        child.kill().expect("stop cat fixture");
        let status = child.wait().expect("wait for cat fixture");

        // Assert
        let expected_size = resized;
        assert_eq!(
            pair.master.get_size().expect("read pty size"),
            expected_size
        );
        assert!(
            !status.success(),
            "stopped cat fixture must not exit successfully"
        );
        let output = output.expect("receive pty echo");
        assert!(
            String::from_utf8_lossy(&output).contains("snowman ☃"),
            "pty must preserve UTF-8 input and output: {}",
            String::from_utf8_lossy(&output)
        );
    }

    #[test]
    fn codex_command_keeps_cli_default_and_uses_literal_pr_prompt() {
        // Arrange
        let repository_root = Path::new("/tmp/linked-repository");
        let initial_prompt = "Review https://github.com/acme/widgets/pull/42";

        // Act
        let command = codex_command(
            repository_root,
            None,
            initial_prompt,
            "/tmp/answer.sock",
            "token",
        );
        let rendered = format!("{command:?}");

        // Assert
        assert!(
            rendered.contains("read-only"),
            "Codex must start read-only: {rendered}"
        );
        assert!(
            rendered.contains(initial_prompt),
            "PR prompt must be a literal argv: {rendered}"
        );
        assert!(
            !rendered.contains("--model"),
            "CLI-default model must omit --model: {rendered}"
        );
        assert!(
            rendered.contains("mcp_servers.pr_visualizer.command"),
            "Codex must receive a per-launch app MCP server: {rendered}"
        );
        assert!(
            rendered.contains("--render-mcp"),
            "Codex must launch the desktop executable in helper mode: {rendered}"
        );
        assert!(
            rendered.contains("PR_VISUALIZER_RENDER_SOCKET"),
            "only this Codex child must receive the private render socket: {rendered}"
        );
        assert!(
            rendered.contains("mcp_servers.pr_visualizer.env_vars"),
            "Codex must forward the private socket credentials to its MCP helper: {rendered}"
        );
        assert!(
            rendered.contains("mcp_servers.pr_visualizer.default_tools_approval_mode"),
            "the app MCP server must not interrupt this approved terminal session: {rendered}"
        );
        assert!(
            rendered.contains("/tmp/linked-repository"),
            "Codex must run in linked repo: {rendered}"
        );
    }

    #[test]
    fn claude_command_registers_app_mcp_blocks_edits_and_uses_literal_pr_prompt() {
        // Arrange
        let repository_root = Path::new("/tmp/linked-repository");
        let model = Some("opus");
        let initial_prompt = "Review https://github.com/acme/widgets/pull/42";
        let render_socket = "/tmp/answer.sock";
        let render_token = "token";

        // Act
        let command = claude_command(
            repository_root,
            model,
            initial_prompt,
            render_socket,
            render_token,
        );
        let rendered = format!("{command:?}");

        // Assert
        let expected_fragments = [
            "--mcp-config",
            "mcpServers",
            "pr_visualizer",
            "--render-mcp",
            "PR_VISUALIZER_RENDER_SOCKET",
            "mcp__pr_visualizer",
            "Bash(sem diff *)",
            "--disallowedTools",
            "Edit",
            "--permission-mode",
            "manual",
            "--model",
            "opus",
            initial_prompt,
            "/tmp/linked-repository",
            "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN",
        ];
        for fragment in expected_fragments {
            assert!(
                rendered.contains(fragment),
                "Claude command must contain {fragment:?}: {rendered}"
            );
        }
        for forbidden_fragment in ["--sandbox", "--no-alt-screen", "Bash(git"] {
            assert!(
                !rendered.contains(forbidden_fragment),
                "Claude command must not contain {forbidden_fragment:?}: {rendered}"
            );
        }
    }

    #[test]
    fn claude_command_keeps_cli_default_model() {
        // Arrange
        let repository_root = Path::new("/tmp/linked-repository");
        let model = None;
        let initial_prompt = "Review https://github.com/acme/widgets/pull/42";

        // Act
        let command = claude_command(
            repository_root,
            model,
            initial_prompt,
            "/tmp/answer.sock",
            "token",
        );
        let rendered = format!("{command:?}");

        // Assert
        assert!(
            !rendered.contains("--model"),
            "CLI-default model must omit --model: {rendered}"
        );
    }

    #[test]
    fn start_request_parses_provider() {
        // Arrange
        let request_without_provider = r#"{
            "sessionId": "session-1",
            "repositoryPath": "/tmp/linked-repository",
            "initialPrompt": "Review",
            "model": null,
            "rows": 24,
            "cols": 80,
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
        let request_with_provider =
            request_without_provider.replace("\"rows\"", "\"provider\": \"claude\", \"rows\"");

        // Act
        let parsed = serde_json::from_str::<CodexTerminalStartRequest>(&request_with_provider);
        let missing = serde_json::from_str::<CodexTerminalStartRequest>(request_without_provider);

        // Assert
        let expected = TerminalProvider::Claude;
        assert_eq!(parsed.expect("request with provider must parse").provider, expected);
        assert!(missing.is_err(), "provider must be required");
    }

    #[cfg(unix)]
    #[test]
    fn stop_escalates_when_terminal_child_ignores_term() {
        // Arrange
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize::default())
            .expect("open a real pty");
        let mut command = CommandBuilder::new("/bin/sh");
        command.arg("-c");
        command.arg("trap '' TERM; printf ready; while :; do sleep 1; done");
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("start resistant fixture");
        let mut reader = pair
            .master
            .try_clone_reader()
            .expect("clone fixture reader");
        let process_group = child
            .process_id()
            .and_then(|pid| i32::try_from(pid).ok())
            .or_else(|| pair.master.process_group_leader());
        let killer = Arc::new(Mutex::new(child.clone_killer()));
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut output = [0_u8; 16];
            let count = reader.read(&mut output).expect("read fixture readiness");
            let _ = ready_sender.send(output[..count].to_vec());
        });
        let ready = ready_receiver
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("receive trap readiness");
        assert!(String::from_utf8_lossy(&ready).contains("ready"));
        let (status_sender, status_receiver) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let status = child.wait().expect("wait for stopped fixture");
            let _ = status_sender.send(status);
        });

        // Act
        let result = stop_terminal_process(&killer, process_group);
        let status = status_receiver
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("reap stopped fixture");

        // Assert
        assert!(
            result.is_ok(),
            "stop must escalate through TERM to KILL: {result:?}"
        );
        assert!(
            !status.success(),
            "TERM-resistant fixture must be terminated"
        );
    }
}
