// Reviewer approvals for the chat (contract §6). Claude asks through `--permission-prompt-tool`,
// the app's own MCP helper forwards each request over the session socket, and the reviewer answers
// in the chat. Every path that is not an explicit reviewer "allow" ends as a deny (R1).
//
// Approval events never go out as app events. They travel only over the Channel the main window
// registered for its session (§6.7), because any webview can listen to an app event.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_PENDING_PER_SESSION: usize = 8;
const MAX_TOOL_NAME_BYTES: usize = 128;
const MAX_REQUEST_ID_BYTES: usize = 64;
const CALLER_POLL_INTERVAL: Duration = Duration::from_millis(200);

// The CLI itself never gives up on a held prompt (measured 13.5 min on 2.1.323), so the app's
// own expiry is the limit. The chat's MCP server timeout sits above it as a safety net.
pub(crate) const DEFAULT_APPROVAL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
// One minute above the app's expiry, so the app always answers first.
pub(crate) const CHAT_MCP_TOOL_TIMEOUT_MS: u64 = (DEFAULT_APPROVAL_TIMEOUT.as_secs() + 60) * 1000;
// R11 and R12. Only the main window may see or answer a request.
pub(crate) const MAIN_WINDOW_LABEL: &str = "main";

pub(crate) const REASON_INTERRUPTED: &str = "you interrupted the turn";
pub(crate) const REASON_STOPPED: &str = "the chat was stopped";
pub(crate) const REASON_SESSION_ENDED: &str = "the chat session ended";
pub(crate) const REASON_ATTACHED: &str = "the chat reconnected before this was answered";
pub const REASON_RELOADED: &str = "the review window reloaded before this was answered";
pub const REASON_APP_QUIT: &str = "PR Visualizer is quitting";
pub const REASON_WINDOW_CLOSED: &str = "the review window was closed before this was answered";
const REASON_CALLER_GONE: &str = "Claude cancelled the request";
const REASON_NOT_OPEN: &str = "this chat session is not accepting approvals";
const REASON_NO_WATCHER: &str = "the review window is not listening for approvals";
const REASON_MALFORMED: &str = "the request did not name a tool and its input";
const REASON_TOO_MANY: &str = "8 approvals are already waiting in this chat";

const REVIEWER_DENY_MESSAGE: &str = "The reviewer denied this command in PR Visualizer. Do not retry it. Continue with a simpler read-only command, or explain in your reply what you need.";

// ---------------------------------------------------------------------------------------------
// Shapes shared with the webview (frozen in contract §6.6 and §6.7)
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalState {
    Pending,
    Allowed,
    Denied,
    Cancelled,
    Expired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeniedBy {
    Reviewer,
    App,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatApprovalEvent {
    pub session_id: String,
    pub request_id: String,
    pub tool_name: String,
    // The exact stored input. `None` only when it was too large to show.
    pub input: Option<serde_json::Value>,
    pub state: ApprovalState,
    pub denied_by: Option<DeniedBy>,
    pub reason: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalDecision {
    Allow,
    Deny,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatApprovalAnswerRequest {
    pub session_id: String,
    pub request_id: String,
    pub decision: ApprovalDecision,
}

// What the CLI sends to the prompt tool (verified shape, contract §6.1).
#[derive(Debug, Deserialize)]
struct ApprovalPrompt {
    tool_name: String,
    input: serde_json::Value,
}

// Delivers one event to the window watching a session. A Tauri Channel send never reports a
// closed window, so a closed main window is handled by its Destroyed event instead (§10 F1).
type Watcher = Arc<dyn Fn(&AiChatApprovalEvent) + Send + Sync>;

// ---------------------------------------------------------------------------------------------
// Verdicts and endings (pure)
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
enum Verdict {
    // Carries the input the app stored when the request arrived (R3).
    Allow(serde_json::Value),
    Deny(String),
}

impl Verdict {
    // The prompt tool's answer, in the JSON shape the CLI accepts (contract §6.1).
    fn cli_result(&self) -> serde_json::Value {
        match self {
            Self::Allow(input) => serde_json::json!({ "behavior": "allow", "updatedInput": input }),
            Self::Deny(message) => serde_json::json!({ "behavior": "deny", "message": message }),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Ending {
    Allowed,
    DeniedByReviewer,
    DeniedByApp(String),
    Cancelled(String),
    Expired(Duration),
}

impl Ending {
    fn verdict(&self, input: &serde_json::Value) -> Verdict {
        match self {
            Self::Allowed => Verdict::Allow(input.clone()),
            Self::DeniedByReviewer => Verdict::Deny(REVIEWER_DENY_MESSAGE.into()),
            Self::DeniedByApp(reason) => Verdict::Deny(app_deny_message(reason)),
            Self::Cancelled(reason) => Verdict::Deny(format!(
                "PR Visualizer cancelled this request because {reason}. Do not retry it unless the reviewer asks."
            )),
            Self::Expired(timeout) => Verdict::Deny(format!(
                "The reviewer did not answer within {}, so PR Visualizer denied this command. Do not retry it. Continue with a simpler read-only command, or explain in your reply what you need.",
                spoken_duration(*timeout)
            )),
        }
    }

    fn state(&self) -> (ApprovalState, Option<DeniedBy>, Option<String>) {
        match self {
            Self::Allowed => (ApprovalState::Allowed, None, None),
            Self::DeniedByReviewer => (ApprovalState::Denied, Some(DeniedBy::Reviewer), None),
            Self::DeniedByApp(reason) => (
                ApprovalState::Denied,
                Some(DeniedBy::App),
                Some(reason.clone()),
            ),
            Self::Cancelled(reason) => (ApprovalState::Cancelled, None, Some(reason.clone())),
            Self::Expired(timeout) => (
                ApprovalState::Expired,
                None,
                Some(format!(
                    "nobody answered within {}",
                    spoken_duration(*timeout)
                )),
            ),
        }
    }
}

fn app_deny_message(reason: &str) -> String {
    format!(
        "PR Visualizer denied this command without asking the reviewer: {reason}. Do not retry it. Continue with a simpler read-only command."
    )
}

fn spoken_duration(duration: Duration) -> String {
    let seconds = duration.as_secs();
    if seconds >= 60 && seconds.is_multiple_of(60) {
        return format!("{} minutes", seconds / 60);
    }

    format!("{seconds} seconds")
}

fn too_large_reason() -> String {
    format!(
        "the request is larger than {} KB, too large to show",
        MAX_INPUT_BYTES / 1024
    )
}

// ---------------------------------------------------------------------------------------------
// The book: every rule lives here. Delivery goes through an injected watcher.
// ---------------------------------------------------------------------------------------------

struct PendingApproval {
    request_id: String,
    tool_name: String,
    input: serde_json::Value,
    verdict: mpsc::Sender<Verdict>,
}

struct SessionApprovals {
    generation: u64,
    watcher: Option<Watcher>,
    pending: Vec<PendingApproval>,
}

impl SessionApprovals {
    fn announce(&self, event: AiChatApprovalEvent) {
        if let Some(watcher) = &self.watcher {
            watcher(&event);
        }
    }

    fn end_all(&mut self, session_id: &str, ending: &Ending) {
        let pending = std::mem::take(&mut self.pending);
        for pending in pending {
            let event = finish(session_id, pending, ending);
            self.announce(event);
        }
    }
}

enum Admission {
    // The request waits for the reviewer. The receiver gets exactly one verdict.
    Pending(mpsc::Receiver<Verdict>),
    // Decided by the app without asking (R7, R1).
    Settled(Verdict),
}

#[derive(Default)]
struct ApprovalBook {
    sessions: HashMap<String, SessionApprovals>,
}

impl ApprovalBook {
    // A new generation of a session ID first ends whatever the earlier one left pending (R2).
    fn open(&mut self, session_id: &str, generation: u64) {
        self.close_any(session_id, REASON_SESSION_ENDED);
        self.sessions.insert(
            session_id.to_string(),
            SessionApprovals {
                generation,
                watcher: None,
                pending: Vec::new(),
            },
        );
    }

    // One watcher per session. A new one replaces the old one, and what the old window was
    // showing is cancelled there, because it is never re-delivered.
    fn watch(&mut self, session_id: &str, watcher: Watcher) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| "chat session is no longer active".to_string())?;
        session.end_all(session_id, &Ending::Cancelled(REASON_RELOADED.into()));
        session.watcher = Some(watcher);
        Ok(())
    }

    fn admit(
        &mut self,
        session_id: &str,
        request_id: String,
        payload: serde_json::Value,
    ) -> Admission {
        let Ok(prompt) = serde_json::from_value::<ApprovalPrompt>(payload) else {
            return Admission::Settled(Verdict::Deny(app_deny_message(REASON_MALFORMED)));
        };
        let is_valid_tool_name =
            !prompt.tool_name.is_empty() && prompt.tool_name.len() <= MAX_TOOL_NAME_BYTES;
        if !is_valid_tool_name || !prompt.input.is_object() {
            return Admission::Settled(Verdict::Deny(app_deny_message(REASON_MALFORMED)));
        }
        let Some(session) = self.sessions.get_mut(session_id) else {
            return Admission::Settled(Verdict::Deny(app_deny_message(REASON_NOT_OPEN)));
        };
        // With no window watching, nobody could see the card, so the app denies at once.
        if session.watcher.is_none() {
            return Admission::Settled(Verdict::Deny(app_deny_message(REASON_NO_WATCHER)));
        }

        let mut event = AiChatApprovalEvent {
            session_id: session_id.to_string(),
            request_id: request_id.clone(),
            tool_name: prompt.tool_name.clone(),
            input: Some(prompt.input.clone()),
            state: ApprovalState::Pending,
            denied_by: None,
            reason: None,
        };
        let input_bytes =
            serde_json::to_string(&prompt.input).map_or(usize::MAX, |text| text.len());
        let refusal = if input_bytes > MAX_INPUT_BYTES {
            event.input = None;
            Some(too_large_reason())
        } else if session.pending.len() >= MAX_PENDING_PER_SESSION {
            Some(REASON_TOO_MANY.to_string())
        } else {
            None
        };
        if let Some(reason) = refusal {
            let ending = Ending::DeniedByApp(reason);
            (event.state, event.denied_by, event.reason) = ending.state();
            session.announce(event);
            return Admission::Settled(ending.verdict(&serde_json::Value::Null));
        }

        let (sender, receiver) = mpsc::channel();
        session.pending.push(PendingApproval {
            request_id,
            tool_name: prompt.tool_name,
            input: prompt.input,
            verdict: sender,
        });
        session.announce(event);
        Admission::Pending(receiver)
    }

    // First answer wins (R2): an answered request is no longer pending, so a second answer fails.
    fn decide(
        &mut self,
        session_id: &str,
        request_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), String> {
        let ending = match decision {
            ApprovalDecision::Allow => Ending::Allowed,
            ApprovalDecision::Deny => Ending::DeniedByReviewer,
        };
        if !self.end(session_id, request_id, ending) {
            return Err("this approval request is no longer pending".into());
        }

        Ok(())
    }

    fn end(&mut self, session_id: &str, request_id: &str, ending: Ending) -> bool {
        let Some(session) = self.sessions.get_mut(session_id) else {
            return false;
        };
        let Some(index) = session
            .pending
            .iter()
            .position(|pending| pending.request_id == request_id)
        else {
            return false;
        };

        let pending = session.pending.remove(index);
        let event = finish(session_id, pending, &ending);
        session.announce(event);
        true
    }

    fn cancel_all(&mut self, session_id: &str, reason: &str) {
        if let Some(session) = self.sessions.get_mut(session_id) {
            session.end_all(session_id, &Ending::Cancelled(reason.into()));
        }
    }

    // Only the generation that opened the entry may close it, so a late cleanup of an ended
    // session cannot close a newer one with the same ID.
    fn close(&mut self, session_id: &str, generation: u64, reason: &str) {
        let is_same_generation = self
            .sessions
            .get(session_id)
            .is_some_and(|session| session.generation == generation);
        if is_same_generation {
            self.close_any(session_id, reason);
        }
    }

    fn close_all(&mut self, reason: &str) {
        let session_ids: Vec<String> = self.sessions.keys().cloned().collect();
        for session_id in session_ids {
            self.close_any(&session_id, reason);
        }
    }

    // Ends what is pending, tells the watching window, then drops the session and its watcher.
    fn close_any(&mut self, session_id: &str, reason: &str) {
        if let Some(mut session) = self.sessions.remove(session_id) {
            session.end_all(session_id, &Ending::Cancelled(reason.into()));
        }
    }
}

fn finish(session_id: &str, pending: PendingApproval, ending: &Ending) -> AiChatApprovalEvent {
    let _ = pending.verdict.send(ending.verdict(&pending.input));
    let (state, denied_by, reason) = ending.state();
    AiChatApprovalEvent {
        session_id: session_id.to_string(),
        request_id: pending.request_id,
        tool_name: pending.tool_name,
        input: Some(pending.input),
        state,
        denied_by,
        reason,
    }
}

// ---------------------------------------------------------------------------------------------
// The edge: shared state, the window's Channel, and the wait on the socket thread
// ---------------------------------------------------------------------------------------------

// Holds no AppHandle and no emitter by design: approval data leaves only through the watching
// window's Channel, never as an app event that any webview could listen to (§6.7).
#[derive(Clone)]
pub struct ChatApprovals {
    book: Arc<Mutex<ApprovalBook>>,
    timeout: Duration,
}

impl Default for ChatApprovals {
    fn default() -> Self {
        Self::with_timeout(DEFAULT_APPROVAL_TIMEOUT)
    }
}

impl ChatApprovals {
    pub(crate) fn with_timeout(timeout: Duration) -> Self {
        Self {
            book: Arc::default(),
            timeout,
        }
    }

    pub(crate) fn open(&self, session_id: &str, generation: u64) {
        self.with_book(|book| book.open(session_id, generation));
    }

    pub(crate) fn watch(
        &self,
        session_id: &str,
        channel: Channel<AiChatApprovalEvent>,
    ) -> Result<(), String> {
        let watcher: Watcher = Arc::new(move |event| {
            let _ = channel.send(event.clone());
        });
        self.book
            .lock()
            .map_err(|_| "approval state is unavailable".to_string())?
            .watch(session_id, watcher)
    }

    pub(crate) fn close(&self, session_id: &str, generation: u64, reason: &str) {
        self.with_book(|book| book.close(session_id, generation, reason));
    }

    pub(crate) fn cancel_all(&self, session_id: &str, reason: &str) {
        self.with_book(|book| book.cancel_all(session_id, reason));
    }

    pub fn close_all(&self, reason: &str) {
        self.with_book(|book| book.close_all(reason));
    }

    pub(crate) fn decide(&self, request: &AiChatApprovalAnswerRequest) -> Result<(), String> {
        validated_request_id(&request.request_id)?;
        self.book
            .lock()
            .map_err(|_| "approval state is unavailable".to_string())?
            .decide(&request.session_id, &request.request_id, request.decision)
    }

    // Runs on the socket thread for one prompt and returns the prompt tool's answer. It waits for
    // the reviewer, the expiry, or the helper hanging up, whichever comes first.
    pub(crate) fn ask(
        &self,
        session_id: &str,
        payload: serde_json::Value,
        caller_gone: impl Fn() -> bool,
    ) -> serde_json::Value {
        let request_id = new_request_id();
        let admission = match self.book.lock() {
            Ok(mut book) => book.admit(session_id, request_id.clone(), payload),
            Err(_) => return unavailable_approval_answer(),
        };
        match admission {
            Admission::Settled(verdict) => verdict.cli_result(),
            Admission::Pending(verdict) => self
                .wait_for_verdict(session_id, &request_id, verdict, caller_gone)
                .cli_result(),
        }
    }

    fn wait_for_verdict(
        &self,
        session_id: &str,
        request_id: &str,
        verdict: mpsc::Receiver<Verdict>,
        caller_gone: impl Fn() -> bool,
    ) -> Verdict {
        let deadline = Instant::now() + self.timeout;
        loop {
            match verdict.recv_timeout(CALLER_POLL_INTERVAL) {
                Ok(verdict) => return verdict,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Verdict::Deny(app_deny_message(REASON_SESSION_ENDED))
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }

            let ending = if caller_gone() {
                Ending::Cancelled(REASON_CALLER_GONE.into())
            } else if Instant::now() >= deadline {
                Ending::Expired(self.timeout)
            } else {
                continue;
            };
            // Ending sends the verdict, so the next receive returns it. If the reviewer answered
            // in between, that answer is already waiting and wins.
            self.with_book(|book| {
                book.end(session_id, request_id, ending);
            });
        }
    }

    fn with_book(&self, action: impl FnOnce(&mut ApprovalBook)) {
        if let Ok(mut book) = self.book.lock() {
            action(&mut book);
        }
    }
}

// The answer when the app has no approval state at all (never expected outside tests).
pub(crate) fn unavailable_approval_answer() -> serde_json::Value {
    Verdict::Deny(app_deny_message(REASON_NOT_OPEN)).cli_result()
}

fn new_request_id() -> String {
    // 128 random bits from the OS, never a counter, so an ID cannot be guessed.
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).expect("the operating system random source must be available");
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("approval-{hex}")
}

fn validated_request_id(request_id: &str) -> Result<&str, String> {
    let is_valid = !request_id.is_empty()
        && request_id.len() <= MAX_REQUEST_ID_BYTES
        && request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    if !is_valid {
        return Err("approval request ID is not valid".into());
    }

    Ok(request_id)
}

// A real Tauri Channel, built the way a test stands in for the main window, recording what it was sent.
#[cfg(test)]
pub(crate) fn recording_channel() -> (
    Channel<AiChatApprovalEvent>,
    mpsc::Receiver<serde_json::Value>,
) {
    let (sender, receiver) = mpsc::channel();
    let channel = Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(json) = body {
            if let Ok(payload) = serde_json::from_str(&json) {
                let _ = sender.send(payload);
            }
        }
        Ok(())
    });
    (channel, receiver)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION_ID: &str = "chat-1";
    const GENERATION: u64 = 7;

    type Recorded = Arc<Mutex<Vec<AiChatApprovalEvent>>>;

    fn bash_prompt(command: &str) -> serde_json::Value {
        serde_json::json!({
            "tool_name": "Bash",
            "input": { "command": command, "description": "Create a probe file" },
            "tool_use_id": "toolu_01",
        })
    }

    fn recording_watcher() -> (Watcher, Recorded) {
        let recorded: Recorded = Arc::default();
        let sink = Arc::clone(&recorded);
        let watcher: Watcher = Arc::new(move |event| {
            sink.lock().expect("record").push(event.clone());
        });
        (watcher, recorded)
    }

    fn states(recorded: &Recorded) -> Vec<(String, ApprovalState, Option<String>)> {
        recorded
            .lock()
            .expect("read")
            .iter()
            .map(|event| (event.request_id.clone(), event.state, event.reason.clone()))
            .collect()
    }

    fn last_event(recorded: &Recorded) -> AiChatApprovalEvent {
        recorded
            .lock()
            .expect("read")
            .last()
            .cloned()
            .expect("an event")
    }

    fn watched_book() -> (ApprovalBook, Recorded) {
        let mut book = ApprovalBook::default();
        book.open(SESSION_ID, GENERATION);
        let (watcher, recorded) = recording_watcher();
        book.watch(SESSION_ID, watcher).expect("watch");
        (book, recorded)
    }

    fn admit_pending(
        book: &mut ApprovalBook,
        request_id: &str,
        command: &str,
    ) -> mpsc::Receiver<Verdict> {
        match book.admit(SESSION_ID, request_id.into(), bash_prompt(command)) {
            Admission::Pending(verdict) => verdict,
            Admission::Settled(_) => panic!("request must wait for the reviewer"),
        }
    }

    fn settled(admission: Admission) -> Verdict {
        match admission {
            Admission::Settled(verdict) => verdict,
            Admission::Pending(_) => panic!("request must be settled by the app"),
        }
    }

    #[test]
    fn a_new_request_waits_for_the_reviewer_with_the_exact_input() {
        // Arrange
        let (mut book, recorded) = watched_book();
        let request_id = "approval-1";

        // Act
        let _verdict = admit_pending(&mut book, request_id, "touch a.txt");

        // Assert
        let expected = vec![AiChatApprovalEvent {
            session_id: SESSION_ID.into(),
            request_id: request_id.into(),
            tool_name: "Bash".into(),
            input: Some(serde_json::json!({
                "command": "touch a.txt",
                "description": "Create a probe file",
            })),
            state: ApprovalState::Pending,
            denied_by: None,
            reason: None,
        }];
        assert_eq!(*recorded.lock().expect("read"), expected);
    }

    #[test]
    fn allow_returns_the_input_the_app_stored() {
        // Arrange
        let (mut book, recorded) = watched_book();
        let request_id = "approval-1";
        let verdict = admit_pending(&mut book, request_id, "touch a.txt");

        // Act
        let decided = book.decide(SESSION_ID, request_id, ApprovalDecision::Allow);

        // Assert
        assert_eq!(decided, Ok(()));
        assert_eq!(last_event(&recorded).state, ApprovalState::Allowed);
        let expected = serde_json::json!({
            "behavior": "allow",
            "updatedInput": { "command": "touch a.txt", "description": "Create a probe file" },
        });
        assert_eq!(verdict.recv().expect("verdict").cli_result(), expected);
    }

    #[test]
    fn a_reviewer_deny_tells_the_model_who_denied_and_how_to_carry_on() {
        // Arrange
        let (mut book, recorded) = watched_book();
        let request_id = "approval-1";
        let verdict = admit_pending(&mut book, request_id, "touch a.txt");

        // Act
        book.decide(SESSION_ID, request_id, ApprovalDecision::Deny)
            .expect("decision applies");

        // Assert
        let last = last_event(&recorded);
        let expected_state = (ApprovalState::Denied, Some(DeniedBy::Reviewer));
        assert_eq!((last.state, last.denied_by), expected_state);
        let expected = serde_json::json!({ "behavior": "deny", "message": REVIEWER_DENY_MESSAGE });
        assert_eq!(verdict.recv().expect("verdict").cli_result(), expected);
    }

    #[test]
    fn the_first_answer_wins_and_a_second_answer_is_refused() {
        // Arrange
        let (mut book, _recorded) = watched_book();
        let request_id = "approval-1";
        let verdict = admit_pending(&mut book, request_id, "touch a.txt");
        book.decide(SESSION_ID, request_id, ApprovalDecision::Deny)
            .expect("first answer applies");

        // Act
        let second = book.decide(SESSION_ID, request_id, ApprovalDecision::Allow);

        // Assert
        let expected = Err("this approval request is no longer pending".to_string());
        assert_eq!(second, expected);
        assert!(matches!(verdict.recv(), Ok(Verdict::Deny(_))));
        assert!(
            verdict.try_recv().is_err(),
            "exactly one verdict reaches the CLI"
        );
    }

    #[test]
    fn a_decision_for_an_unknown_request_is_refused() {
        // Arrange
        let (mut book, _recorded) = watched_book();
        let unknown_request_id = "approval-unknown";

        // Act
        let result = book.decide(SESSION_ID, unknown_request_id, ApprovalDecision::Allow);

        // Assert
        assert!(result.is_err());
    }

    #[test]
    fn a_decision_naming_another_session_is_refused() {
        // Arrange
        let (mut book, _recorded) = watched_book();
        let request_id = "approval-1";
        let other_session_id = "chat-2";
        book.open(other_session_id, GENERATION + 1);
        let verdict = admit_pending(&mut book, request_id, "touch a.txt");

        // Act
        let result = book.decide(other_session_id, request_id, ApprovalDecision::Allow);

        // Assert
        assert!(result.is_err());
        assert!(verdict.try_recv().is_err(), "the request stays pending");
    }

    #[test]
    fn a_decision_for_an_earlier_generation_of_the_session_is_refused() {
        // Arrange
        let (mut book, _recorded) = watched_book();
        let request_id = "approval-1";
        let verdict = admit_pending(&mut book, request_id, "touch a.txt");
        book.open(SESSION_ID, GENERATION + 1);

        // Act
        let result = book.decide(SESSION_ID, request_id, ApprovalDecision::Allow);

        // Assert
        assert!(result.is_err());
        assert!(
            matches!(verdict.recv(), Ok(Verdict::Deny(_))),
            "reopening the session ID ends the old request as a deny"
        );
    }

    #[test]
    fn a_request_for_a_session_that_does_not_host_approvals_is_denied_by_the_app() {
        // Arrange
        let mut book = ApprovalBook::default();
        let terminal_session_id = "terminal-1";

        // Act
        let admission = book.admit(terminal_session_id, "approval-1".into(), bash_prompt("ls"));

        // Assert
        let expected = Verdict::Deny(app_deny_message(REASON_NOT_OPEN));
        assert_eq!(settled(admission), expected);
    }

    #[test]
    fn a_request_with_no_watcher_is_denied_by_the_app() {
        // Arrange
        let mut book = ApprovalBook::default();
        book.open(SESSION_ID, GENERATION);

        // Act
        let admission = book.admit(SESSION_ID, "approval-1".into(), bash_prompt("touch a.txt"));

        // Assert
        let expected_message = "PR Visualizer denied this command without asking the reviewer: the review window is not listening for approvals. Do not retry it. Continue with a simpler read-only command.";
        assert_eq!(settled(admission), Verdict::Deny(expected_message.into()));
    }

    #[test]
    fn a_watch_for_a_session_that_is_not_open_is_refused() {
        // Arrange
        let mut book = ApprovalBook::default();
        let (watcher, _recorded) = recording_watcher();

        // Act
        let result = book.watch("chat-missing", watcher);

        // Assert
        assert_eq!(result, Err("chat session is no longer active".to_string()));
    }

    #[test]
    fn a_second_watch_replaces_the_first_and_cancels_what_was_pending() {
        // Arrange
        let (mut book, first_window) = watched_book();
        let verdict = admit_pending(&mut book, "approval-1", "touch a.txt");
        let (second_watcher, second_window) = recording_watcher();

        // Act
        book.watch(SESSION_ID, second_watcher)
            .expect("second watch");
        let _later = admit_pending(&mut book, "approval-2", "touch b.txt");

        // Assert
        let expected_first = vec![
            ("approval-1".to_string(), ApprovalState::Pending, None),
            (
                "approval-1".to_string(),
                ApprovalState::Cancelled,
                Some(REASON_RELOADED.to_string()),
            ),
        ];
        assert_eq!(states(&first_window), expected_first);
        assert!(matches!(verdict.recv(), Ok(Verdict::Deny(_))));
        let expected_second = vec![("approval-2".to_string(), ApprovalState::Pending, None)];
        assert_eq!(
            states(&second_window),
            expected_second,
            "new requests go to the new window"
        );
    }

    #[test]
    fn a_malformed_request_is_denied_without_asking() {
        // Arrange
        let (mut book, recorded) = watched_book();
        let malformed = serde_json::json!({ "tool_name": "", "input": "not an object" });

        // Act
        let admission = book.admit(SESSION_ID, "approval-1".into(), malformed);

        // Assert
        let expected = Verdict::Deny(app_deny_message(REASON_MALFORMED));
        assert_eq!(settled(admission), expected);
        assert!(recorded.lock().expect("read").is_empty());
    }

    #[test]
    fn an_input_over_64_kb_is_denied_by_the_app_without_asking() {
        // Arrange
        let (mut book, recorded) = watched_book();
        let command = "a".repeat(MAX_INPUT_BYTES);

        // Act
        let admission = book.admit(SESSION_ID, "approval-1".into(), bash_prompt(&command));

        // Assert
        let expected_reason = "the request is larger than 64 KB, too large to show";
        let expected_verdict = Verdict::Deny(app_deny_message(expected_reason));
        assert_eq!(settled(admission), expected_verdict);
        let event = last_event(&recorded);
        assert_eq!(event.state, ApprovalState::Denied);
        assert_eq!(event.denied_by, Some(DeniedBy::App));
        assert_eq!(event.input, None, "an input too large to show is not sent");
        assert_eq!(event.reason.as_deref(), Some(expected_reason));
    }

    #[test]
    fn a_ninth_pending_request_is_denied_by_the_app() {
        // Arrange
        let (mut book, recorded) = watched_book();
        let _waiting: Vec<_> = (0..MAX_PENDING_PER_SESSION)
            .map(|index| admit_pending(&mut book, &format!("approval-{index}"), "touch a.txt"))
            .collect();

        // Act
        let admission = book.admit(SESSION_ID, "approval-9".into(), bash_prompt("touch b.txt"));

        // Assert
        let expected = Verdict::Deny(app_deny_message(REASON_TOO_MANY));
        assert_eq!(settled(admission), expected);
        assert_eq!(last_event(&recorded).denied_by, Some(DeniedBy::App));
    }

    #[test]
    fn cancel_all_denies_every_pending_request_of_the_session_with_the_reason() {
        // Arrange
        let (mut book, recorded) = watched_book();
        let first = admit_pending(&mut book, "approval-1", "touch a.txt");
        let second = admit_pending(&mut book, "approval-2", "touch b.txt");

        // Act
        book.cancel_all(SESSION_ID, REASON_INTERRUPTED);

        // Assert
        let ended: Vec<_> = states(&recorded).into_iter().skip(2).collect();
        let interrupted = Some(REASON_INTERRUPTED.to_string());
        let expected = vec![
            (
                "approval-1".to_string(),
                ApprovalState::Cancelled,
                interrupted.clone(),
            ),
            (
                "approval-2".to_string(),
                ApprovalState::Cancelled,
                interrupted,
            ),
        ];
        assert_eq!(ended, expected);
        assert!(matches!(first.recv(), Ok(Verdict::Deny(_))));
        assert!(matches!(second.recv(), Ok(Verdict::Deny(_))));
    }

    #[test]
    fn closing_a_session_denies_its_pending_requests_and_drops_its_watcher() {
        // Arrange
        let (mut book, recorded) = watched_book();
        let verdict = admit_pending(&mut book, "approval-1", "touch a.txt");

        // Act
        book.close(SESSION_ID, GENERATION, REASON_SESSION_ENDED);
        book.open(SESSION_ID, GENERATION + 1);
        let later = book.admit(SESSION_ID, "approval-2".into(), bash_prompt("touch b.txt"));

        // Assert
        assert!(matches!(verdict.recv(), Ok(Verdict::Deny(_))));
        assert_eq!(
            last_event(&recorded).reason.as_deref(),
            Some(REASON_SESSION_ENDED)
        );
        assert_eq!(
            settled(later),
            Verdict::Deny(app_deny_message(REASON_NO_WATCHER)),
            "a reopened session starts without the old watcher"
        );
    }

    #[test]
    fn a_stale_generation_cannot_close_the_newer_session() {
        // Arrange
        let mut book = ApprovalBook::default();
        book.open(SESSION_ID, GENERATION);
        book.open(SESSION_ID, GENERATION + 1);
        let (watcher, _recorded) = recording_watcher();
        book.watch(SESSION_ID, watcher).expect("watch");
        let verdict = admit_pending(&mut book, "approval-1", "touch a.txt");

        // Act
        book.close(SESSION_ID, GENERATION, REASON_SESSION_ENDED);

        // Assert
        assert!(
            verdict.try_recv().is_err(),
            "the newer session's request stays pending"
        );
    }

    #[test]
    fn a_page_reload_denies_pending_requests_of_every_session() {
        // Arrange
        let (mut book, recorded) = watched_book();
        book.open("chat-2", GENERATION + 1);
        let first = admit_pending(&mut book, "approval-1", "touch a.txt");

        // Act
        book.close_all(REASON_RELOADED);

        // Assert
        assert!(matches!(first.recv(), Ok(Verdict::Deny(_))));
        assert_eq!(
            last_event(&recorded).reason.as_deref(),
            Some(REASON_RELOADED)
        );
        assert!(book.sessions.is_empty());
    }

    #[test]
    fn an_expired_request_is_denied_with_a_plain_message() {
        // Arrange
        let (mut book, recorded) = watched_book();
        let request_id = "approval-1";
        let verdict = admit_pending(&mut book, request_id, "touch a.txt");
        let timeout = Duration::from_secs(10 * 60);

        // Act
        let ended = book.end(SESSION_ID, request_id, Ending::Expired(timeout));

        // Assert
        assert!(ended);
        let last = last_event(&recorded);
        assert_eq!(last.state, ApprovalState::Expired);
        assert_eq!(
            last.reason.as_deref(),
            Some("nobody answered within 10 minutes")
        );
        let expected_message = "The reviewer did not answer within 10 minutes, so PR Visualizer denied this command. Do not retry it. Continue with a simpler read-only command, or explain in your reply what you need.";
        assert_eq!(
            verdict.recv().expect("verdict"),
            Verdict::Deny(expected_message.into())
        );
    }

    #[test]
    fn answer_request_rejects_a_malformed_decision_and_request_id() {
        // Arrange
        let malformed_decision =
            r#"{"sessionId":"chat-1","requestId":"approval-1","decision":"always"}"#;
        let malformed_request_id = "approval 1; rm";

        // Act
        let parsed = serde_json::from_str::<AiChatApprovalAnswerRequest>(malformed_decision);
        let validated = validated_request_id(malformed_request_id);

        // Assert
        assert!(parsed.is_err());
        assert!(validated.is_err());
    }

    #[test]
    fn request_ids_are_random_and_not_a_counter() {
        // Arrange
        let count = 64;

        // Act
        let ids: std::collections::HashSet<String> = (0..count).map(|_| new_request_id()).collect();

        // Assert
        assert_eq!(ids.len(), count);
        assert!(ids.iter().all(|id| id.len() == "approval-".len() + 32));
    }

    #[test]
    fn approval_event_serializes_to_the_contract_shape() {
        // Arrange
        let event = AiChatApprovalEvent {
            session_id: SESSION_ID.into(),
            request_id: "approval-1".into(),
            tool_name: "Bash".into(),
            input: None,
            state: ApprovalState::Denied,
            denied_by: Some(DeniedBy::App),
            reason: Some("too large".into()),
        };

        // Act
        let json = serde_json::to_value(&event).expect("serialize");

        // Assert
        let expected = serde_json::json!({
            "sessionId": SESSION_ID,
            "requestId": "approval-1",
            "toolName": "Bash",
            "input": null,
            "state": "denied",
            "deniedBy": "app",
            "reason": "too large",
        });
        assert_eq!(json, expected);
    }

    mod waiting {
        use super::*;

        const WAIT: Duration = Duration::from_secs(5);

        fn watched_approvals(
            timeout: Duration,
        ) -> (ChatApprovals, mpsc::Receiver<serde_json::Value>) {
            let approvals = ChatApprovals::with_timeout(timeout);
            approvals.open(SESSION_ID, GENERATION);
            let (channel, events) = recording_channel();
            approvals.watch(SESSION_ID, channel).expect("watch");
            (approvals, events)
        }

        fn ask_on_a_thread(
            approvals: &ChatApprovals,
            caller_gone: bool,
        ) -> mpsc::Receiver<serde_json::Value> {
            let (sender, receiver) = mpsc::channel();
            let approvals = approvals.clone();
            std::thread::spawn(move || {
                let prompt = bash_prompt("touch a.txt");
                let answer = approvals.ask(SESSION_ID, prompt, || caller_gone);
                let _ = sender.send(answer);
            });
            receiver
        }

        #[test]
        fn the_reviewers_allow_reaches_the_waiting_prompt() {
            // Arrange
            let (approvals, events) = watched_approvals(DEFAULT_APPROVAL_TIMEOUT);
            let answer = ask_on_a_thread(&approvals, false);
            let pending = events.recv_timeout(WAIT).expect("pending event");

            // Act
            let request = AiChatApprovalAnswerRequest {
                session_id: SESSION_ID.into(),
                request_id: pending["requestId"].as_str().expect("request id").into(),
                decision: ApprovalDecision::Allow,
            };
            let decided = approvals.decide(&request);
            let answer = answer.recv_timeout(WAIT).expect("prompt answered");

            // Assert
            assert_eq!(pending["state"], "pending");
            assert_eq!(decided, Ok(()));
            assert_eq!(answer["behavior"], "allow");
            assert_eq!(answer["updatedInput"]["command"], "touch a.txt");
            let final_event = events.recv_timeout(WAIT).expect("final event");
            assert_eq!(final_event["state"], "allowed");
        }

        #[test]
        fn no_answer_within_the_timeout_ends_as_a_deny() {
            // Arrange
            let (approvals, events) = watched_approvals(Duration::from_millis(300));

            // Act
            let answer = ask_on_a_thread(&approvals, false).recv_timeout(WAIT);

            // Assert
            assert_eq!(answer.expect("prompt answered")["behavior"], "deny");
            let _pending = events.recv_timeout(WAIT).expect("pending event");
            let final_event = events.recv_timeout(WAIT).expect("final event");
            assert_eq!(final_event["state"], "expired");
        }

        #[test]
        fn a_helper_that_hangs_up_cancels_the_request() {
            // Arrange
            let (approvals, events) = watched_approvals(DEFAULT_APPROVAL_TIMEOUT);

            // Act
            let answer = ask_on_a_thread(&approvals, true).recv_timeout(WAIT);

            // Assert
            assert_eq!(answer.expect("prompt answered")["behavior"], "deny");
            let _pending = events.recv_timeout(WAIT).expect("pending event");
            let ended = events.recv_timeout(WAIT).expect("final event");
            assert_eq!(ended["state"], "cancelled");
            assert_eq!(ended["reason"], REASON_CALLER_GONE);
        }

        #[test]
        fn interrupting_the_chat_denies_the_waiting_prompt() {
            // Arrange
            let (approvals, events) = watched_approvals(DEFAULT_APPROVAL_TIMEOUT);
            let answer = ask_on_a_thread(&approvals, false);
            let _pending = events.recv_timeout(WAIT).expect("pending event");

            // Act
            approvals.cancel_all(SESSION_ID, REASON_INTERRUPTED);
            let answer = answer.recv_timeout(WAIT).expect("prompt answered");

            // Assert
            assert_eq!(answer["behavior"], "deny");
            let ended = events.recv_timeout(WAIT).expect("final event");
            assert_eq!(ended["state"], "cancelled");
            assert_eq!(ended["reason"], REASON_INTERRUPTED);
        }
    }
}
