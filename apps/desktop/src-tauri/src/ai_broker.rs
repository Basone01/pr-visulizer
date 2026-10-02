// The launch core is intentionally disconnected from production callers until a real provider
// proves every safety control in design §19; S10 connects only the fake-provider lifecycle.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc::{self, Receiver, Sender},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, Runtime};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

const PROCESS_TERMINATION_GRACE: Duration = Duration::from_millis(250);
const PROCESS_KILL_GRACE: Duration = Duration::from_secs(1);
const CODEX_SAFE_PROFILE_MAX_PROMPT_BYTES: usize = 512 * 1024;
const CODEX_SAFE_PROFILE_MAX_MODEL_LENGTH: usize = 128;
const CODEX_SAFE_PROFILE_MAX_JSONL_LINES: usize = 256;
const CODEX_SAFE_PROFILE_MAX_TERMINAL_BYTES: usize = 256 * 1024;
const CODEX_SAFE_PROFILE_MAX_JSONL_LINE_BYTES: usize = 512 * 1024;
const CODEX_SAFE_PROFILE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CODEX_SAFE_PROFILE_COMPATIBILITY_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const CODEX_SAFE_PROFILE_COMPATIBILITY_PROBE_DRAIN_TIMEOUT: Duration = Duration::from_millis(250);
const CODEX_SAFE_PROFILE_COMPATIBILITY_PROBE_MAX_PIPE_BYTES: usize = 32 * 1024;
const CODEX_SAFE_PROFILE_MAX_EXECUTABLE_BYTES: usize = 512 * 1024 * 1024;
const CODEX_SAFE_PROFILE_MAX_VERIFIED_RECEIPTS: usize = 4;
// A published terminal's run ID has to outlive its control so a repeated cancellation or a late
// launcher cannot publish a second terminal for the same run. Only in-flight runs can collide, so
// this history is bounded well above the widest possible overlap.
const CODEX_SAFE_PROFILE_PUBLISHED_TERMINAL_HISTORY: usize = 64;
const BROKER_MAX_OUTPUT_LINES: usize = 1_024;
const BROKER_MAX_OUTPUT_BYTES: usize = 256 * 1024;
const BROKER_MAX_EVENT_LINE_LENGTH: usize = 4_096;
const BROKER_OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_millis(250);
const CODEX_SAFE_PROFILE_OWNERSHIP_MARKER: &str = ".prv-codex-safe-profile-owned";
const CODEX_SAFE_PROFILE_LIVENESS_RECORD: &str = ".prv-codex-safe-profile-liveness.json";
const CODEX_SAFE_PROFILE_ADMISSION_RECORD: &str = ".prv-codex-safe-profile-admission.json";
const CODEX_SAFE_PROFILE_TERMINAL_RECOVERY_DIRECTORY: &str = ".prv-codex-safe-profile-terminals";
const CODEX_SAFE_PROFILE_OWNERSHIP_MARKER_PREFIX: &str = "prv-codex-safe-profile-owned-v1:";
// Any change to Rust-owned argv, schemas, config, environment, or disabled-control policy must
// change this revision and therefore invalidate prior capability receipts.
const CODEX_SAFE_PROFILE_REVISION: &str = "codex-safe-profile-r2";
const CODEX_SAFE_PROFILE_EXACT_CLI_VERSION: &str = "0.153.4";
// SHA-256 over the bounded, byte-exact `codex --help` and `codex exec --help` observations,
// length-delimited with `\n--exec-help--\n` (see `digest_codex_provenance`). This release
// deliberately accepts no newer CLI/help contract until an app update records a new digest.
const CODEX_SAFE_PROFILE_FIXED_HELP_DIGEST: &str =
    "46757907fde06e635bafb94daa811862c23df2e644e426a9f4b3358fb9c6d72c";

#[cfg(test)]
thread_local! {
    // Test-only fault injection reaches the same post-spawn durable-admission seam used by the
    // public launcher; it is thread-local so parallel tests cannot affect production behavior.
    static FAIL_NEXT_DURABLE_ADMISSION_WRITE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

// The broker captures the desktop's already-adopted login-shell PATH during startup. A webview
// request can never supply a path, executable name, or PATH replacement; it only learns whether
// this fixed broker-owned lookup found Codex.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSafeProfileObservedProvenance {
    // A SHA-256 digest of the opened executable descriptor's vnode/birth/content identity. The
    // descriptor path and executable bytes never cross the Rust boundary.
    pub executable_identity_digest: String,
    pub cli_version: String,
    // This binds fixed top-level and `exec --help` observations, not a caller-provided claim.
    pub help_digest: String,
    pub safe_profile_revision: String,
    // This is the one observed executable/help/profile identity that receipts, launches, and
    // persisted runs bind. It intentionally contains no executable path or provider output.
    pub provenance_fingerprint: String,
}

// macOS vnode identity is only stable when paired with its creation time. Content is included so
// an in-place replacement/upgrade is never treated as a cached compatible executable. Other Unix
// test platforms use their kernel metadata fallback but remain fail-closed on missing identity.
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct CodexExecutableIdentity {
    device: u64,
    inode: u64,
    birth_seconds: i64,
    birth_nanoseconds: i64,
    content_digest: String,
}

#[derive(Clone, Debug)]
struct ObservedCodexExecutable {
    // Rust-only lookup provenance. It is used solely to detect a PATH replacement during the
    // fixed probe; launch never executes this path.
    source_path: PathBuf,
    identity: CodexExecutableIdentity,
    descriptor: Arc<std::fs::File>,
}

#[derive(Clone, Debug)]
struct VerifiedCodexLaunch {
    observed_executable: ObservedCodexExecutable,
    provenance: CodexSafeProfileObservedProvenance,
}

#[derive(Clone, Debug)]
pub struct CodexSafeProfileBroker {
    adopted_login_shell_path: OsString,
    // These broker-owned values form the release compatibility contract. They are private so
    // neither a webview nor a caller can select a version, help digest, or profile revision.
    exact_cli_version: &'static str,
    fixed_help_digest: String,
    safe_profile_revision: &'static str,
    // Compatibility is cached by an immutable descriptor identity, never by a PATH string.
    verified_probe_cache: Arc<Mutex<HashMap<CodexExecutableIdentity, VerifiedCodexLaunch>>>,
    verified_receipts: Arc<Mutex<CodexSafeProfileReceiptRegistry>>,
}

// Every retained receipt holds an open descriptor for the verified executable, so this registry is
// bounded on both axes: one receipt per verified identity, and a hard cap with oldest eviction. An
// evicted or superseded receipt is simply unknown, which fails the public start path closed.
#[derive(Debug, Default)]
struct CodexSafeProfileReceiptRegistry {
    issued: VecDeque<(String, VerifiedCodexLaunch)>,
    issued_count: usize,
}

impl CodexSafeProfileBroker {
    pub fn capture_adopted_login_shell_path() -> Self {
        Self::with_adopted_login_shell_path(std::env::var_os("PATH").unwrap_or_default())
    }

    fn with_adopted_login_shell_path(adopted_login_shell_path: OsString) -> Self {
        Self::with_compatibility_contract(
            adopted_login_shell_path,
            CODEX_SAFE_PROFILE_EXACT_CLI_VERSION,
            CODEX_SAFE_PROFILE_FIXED_HELP_DIGEST.into(),
            CODEX_SAFE_PROFILE_REVISION,
        )
    }

    fn with_compatibility_contract(
        adopted_login_shell_path: OsString,
        exact_cli_version: &'static str,
        fixed_help_digest: String,
        safe_profile_revision: &'static str,
    ) -> Self {
        Self {
            adopted_login_shell_path,
            exact_cli_version,
            fixed_help_digest,
            safe_profile_revision,
            verified_probe_cache: Arc::new(Mutex::new(HashMap::new())),
            verified_receipts: Arc::new(Mutex::new(CodexSafeProfileReceiptRegistry::default())),
        }
    }

    fn resolve_executable(&self) -> Result<PathBuf, String> {
        for directory in std::env::split_paths(&self.adopted_login_shell_path) {
            if !directory.is_absolute() {
                continue;
            }

            let candidate = directory.join("codex");
            let Ok(metadata) = std::fs::metadata(&candidate) else {
                continue;
            };
            if !metadata.is_file() || !is_executable_file(&metadata) {
                continue;
            }

            return candidate
                .canonicalize()
                .map_err(|error| format!("Codex executable could not be resolved: {error}"));
        }

        Err("Codex was not found on the desktop login-shell PATH.".into())
    }

    fn open_observed_executable(&self) -> Result<ObservedCodexExecutable, String> {
        let source_path = self.resolve_executable()?;
        let file = std::fs::File::open(&source_path)
            .map_err(|_| "Codex executable descriptor could not be opened")?;
        let metadata = file
            .metadata()
            .map_err(|_| "Codex executable descriptor could not be inspected")?;
        if !metadata.is_file() || !is_executable_file(&metadata) {
            return Err("Codex executable descriptor is not a regular executable file".into());
        }
        let identity = codex_executable_identity(&file, &metadata)?;
        Ok(ObservedCodexExecutable {
            source_path,
            identity,
            descriptor: Arc::new(file),
        })
    }

    fn probe_verified_launch(&self) -> Result<VerifiedCodexLaunch, CodexSafeProfileCapability> {
        let observed =
            self.open_observed_executable()
                .map_err(|diagnostic| CodexSafeProfileCapability {
                    available: false,
                    cli_version: None,
                    core_controls_verified: false,
                    provenance: None,
                    receipt_id: None,
                    diagnostics: vec![diagnostic],
                })?;
        if let Ok(cache) = self.verified_probe_cache.lock() {
            if let Some(verified) = cache.get(&observed.identity) {
                return Ok(verified.clone());
            }
        } else {
            return Err(failed_codex_compatibility_probe(None));
        }
        let version_output =
            run_bounded_codex_compatibility_probe(self, &observed.source_path, &["--version"])
                .map_err(|_| failed_codex_compatibility_probe(None))?;
        let version = parse_codex_cli_version(&version_output).ok_or_else(|| {
            CodexSafeProfileCapability {
                available: false,
                cli_version: None,
                core_controls_verified: false,
                provenance: None,
                receipt_id: None,
                diagnostics: vec!["The resolved Codex executable did not report a supported semantic CLI version.".into()],
            }
        })?;
        if version != self.exact_cli_version {
            return Err(CodexSafeProfileCapability {
                available: false,
                cli_version: Some(version),
                core_controls_verified: false,
                provenance: None,
                receipt_id: None,
                diagnostics: vec![
                    "The resolved Codex CLI version is incompatible with the safe profile.".into(),
                ],
            });
        }
        let top_level_help =
            run_bounded_codex_compatibility_probe(self, &observed.source_path, &["--help"])
                .map_err(|_| failed_codex_compatibility_probe(Some(version.clone())))?;
        let exec_help =
            run_bounded_codex_compatibility_probe(self, &observed.source_path, &["exec", "--help"])
                .map_err(|_| failed_codex_compatibility_probe(Some(version.clone())))?;
        if !missing_codex_safe_profile_controls(&top_level_help, &exec_help).is_empty() {
            return Err(CodexSafeProfileCapability {
                available: false,
                cli_version: Some(version),
                core_controls_verified: false,
                provenance: None,
                receipt_id: None,
                diagnostics: vec![
                    "The resolved Codex CLI is missing required safe-profile controls.".into(),
                ],
            });
        }
        // The fixed probes execute only without stdin. Re-open and compare the descriptor after
        // them so a PATH entry replacement cannot borrow probe evidence from another executable.
        let reobserved = self
            .open_observed_executable()
            .map_err(|_| failed_codex_compatibility_probe(Some(version.clone())))?;
        if reobserved.identity != observed.identity {
            return Err(failed_codex_compatibility_probe(Some(version)));
        }
        let help_digest = digest_codex_provenance(&[
            top_level_help.as_bytes(),
            b"\n--exec-help--\n",
            exec_help.as_bytes(),
        ]);
        if help_digest != self.fixed_help_digest {
            return Err(CodexSafeProfileCapability {
                available: false,
                cli_version: Some(version),
                core_controls_verified: false,
                provenance: None,
                receipt_id: None,
                diagnostics: vec![
                    "The resolved Codex CLI help/control contract is incompatible with the safe profile."
                        .into(),
                ],
            });
        }
        let provenance_fingerprint = digest_codex_provenance(&[
            observed.identity.content_digest.as_bytes(),
            version.as_bytes(),
            help_digest.as_bytes(),
            self.safe_profile_revision.as_bytes(),
        ]);
        let verified = VerifiedCodexLaunch {
            observed_executable: observed.clone(),
            provenance: CodexSafeProfileObservedProvenance {
                executable_identity_digest: executable_identity_digest(&observed.identity),
                cli_version: version,
                help_digest,
                safe_profile_revision: self.safe_profile_revision.into(),
                provenance_fingerprint,
            },
        };
        let mut cache = self
            .verified_probe_cache
            .lock()
            .map_err(|_| failed_codex_compatibility_probe(None))?;
        // Only one resolved executable can be current, and a superseded identity's cached probe is
        // never reused, so this holds exactly the observed identity instead of growing per upgrade.
        cache.clear();
        cache.insert(observed.identity, verified.clone());
        drop(cache);
        Ok(verified)
    }

    // Idempotent per verified identity: repeated capability probes of the same executable return the
    // receipt already issued for it. A changed identity replaces the previous receipts, and the cap
    // bounds the registry even if an identity were somehow to churn.
    fn issue_verified_receipt(&self, verified: VerifiedCodexLaunch) -> Result<String, String> {
        let mut registry = self
            .verified_receipts
            .lock()
            .map_err(|_| "Codex safe-profile receipt registry is unavailable")?;
        let already_issued = registry.issued.iter().find(|(_, issued)| {
            issued.observed_executable.identity == verified.observed_executable.identity
                && issued.provenance == verified.provenance
        });
        if let Some((receipt_id, _)) = already_issued {
            return Ok(receipt_id.clone());
        }
        registry.issued.retain(|(_, issued)| {
            issued.observed_executable.identity == verified.observed_executable.identity
        });
        while registry.issued.len() >= CODEX_SAFE_PROFILE_MAX_VERIFIED_RECEIPTS {
            registry.issued.pop_front();
        }
        registry.issued_count += 1;
        let receipt_id = format!("cp-{}", registry.issued_count);
        registry.issued.push_back((receipt_id.clone(), verified));
        Ok(receipt_id)
    }

    fn verified_receipt(&self, receipt_id: &str) -> Result<VerifiedCodexLaunch, String> {
        self.verified_receipts
            .lock()
            .map_err(|_| "Codex safe-profile receipt registry is unavailable")?
            .issued
            .iter()
            .find(|(issued_id, _)| issued_id == receipt_id)
            .map(|(_, verified)| verified.clone())
            .ok_or_else(|| "Codex safe-profile capability receipt is missing or stale".into())
    }

    // Queue admission retains the probe result, then launch obtains fresh broker-owned evidence.
    // A replaced binary, changed help contract, unknown version, or profile revision change is a
    // hard launch rejection rather than a best-effort compatibility refresh.
    fn revalidate_verified_launch(
        &self,
        expected: &VerifiedCodexLaunch,
    ) -> Result<VerifiedCodexLaunch, String> {
        let observed = self
            .probe_verified_launch()
            .map_err(|_| "Codex safe-profile launch provenance could not be revalidated")?;
        if observed.provenance != expected.provenance
            || observed.observed_executable.identity != expected.observed_executable.identity
        {
            return Err(
                "Codex safe-profile launch provenance does not match its capability receipt".into(),
            );
        }
        Ok(observed)
    }

    fn capability(&self) -> CodexSafeProfileCapability {
        let verified = match self.probe_verified_launch() {
            Ok(verified) => verified,
            Err(capability) => return capability,
        };
        let receipt_id = match self.issue_verified_receipt(verified.clone()) {
            Ok(receipt_id) => receipt_id,
            Err(_) => {
                return failed_codex_compatibility_probe(Some(verified.provenance.cli_version))
            }
        };
        CodexSafeProfileCapability {
            available: true,
            cli_version: Some(verified.provenance.cli_version.clone()),
            core_controls_verified: true,
            provenance: Some(verified.provenance),
            receipt_id: Some(receipt_id),
            diagnostics: Vec::new(),
        }
    }
}

// Every reader owns its own offset instead of the descriptor's kernel file offset. The verified
// descriptor is an `Arc<File>` shared by the probe cache, the capability receipt, and every start,
// and `try_clone` is `dup(2)`: a duplicate shares that one offset, so a concurrent capability
// probe or a second start could rewind another reader mid-loop and interleave its chunks.
#[cfg(unix)]
fn read_descriptor_chunk_at(
    source: &std::fs::File,
    buffer: &mut [u8],
    offset: u64,
) -> Result<usize, String> {
    use std::os::unix::fs::FileExt;

    source
        .read_at(buffer, offset)
        .map_err(|_| "Codex executable descriptor could not be read".into())
}

// No portable positional read exists off unix, so this is the one explicit serialization fallback.
// The guard covers seek plus read together, which keeps each chunk atomic against every other
// guarded reader of the same shared offset. There is no unguarded seek path.
#[cfg(not(unix))]
static SHARED_DESCRIPTOR_OFFSET_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(not(unix))]
fn read_descriptor_chunk_at(
    source: &std::fs::File,
    buffer: &mut [u8],
    offset: u64,
) -> Result<usize, String> {
    use std::io::{Read, Seek, SeekFrom};

    let _serialized = SHARED_DESCRIPTOR_OFFSET_GUARD
        .lock()
        .map_err(|_| "Codex executable descriptor read guard is unavailable")?;
    let mut reader = source
        .try_clone()
        .map_err(|_| "Codex executable descriptor could not be duplicated")?;
    reader
        .seek(SeekFrom::Start(offset))
        .map_err(|_| "Codex executable descriptor could not be rewound")?;
    reader
        .read(buffer)
        .map_err(|_| "Codex executable descriptor could not be read".into())
}

// One bounded reader feeds both the identity digest and the run-owned materialization, so the two
// callers cannot drift on chunk size, the byte bound, or short-read handling.
fn digest_descriptor_bytes(
    source: &std::fs::File,
    mut sink: impl FnMut(&[u8]) -> Result<(), String>,
) -> Result<String, String> {
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut offset = 0_u64;
    let mut total = 0_usize;
    loop {
        let read = read_descriptor_chunk_at(source, &mut buffer, offset)?;
        if read == 0 {
            break;
        }

        offset = offset.saturating_add(read as u64);
        total = total.saturating_add(read);
        if total > CODEX_SAFE_PROFILE_MAX_EXECUTABLE_BYTES {
            return Err("Codex executable exceeds the broker materialization limit".into());
        }

        sink(&buffer[..read])?;
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn digest_open_executable(file: &std::fs::File) -> Result<String, String> {
    digest_descriptor_bytes(file, |_chunk| Ok(()))
}

fn copy_verified_executable_materialization(
    source: &std::fs::File,
    destination: &mut std::fs::File,
) -> Result<String, String> {
    use std::io::Write;

    let copied_digest = digest_descriptor_bytes(source, |chunk| {
        destination
            .write_all(chunk)
            .map_err(|_| "could not materialize the verified Codex executable".to_string())
    })?;
    destination
        .sync_all()
        .map_err(|_| "could not materialize the verified Codex executable")?;
    Ok(copied_digest)
}

#[cfg(unix)]
fn codex_executable_identity(
    file: &std::fs::File,
    metadata: &std::fs::Metadata,
) -> Result<CodexExecutableIdentity, String> {
    use std::os::unix::fs::MetadataExt;
    let (birth_seconds, birth_nanoseconds) = executable_birth_identity(file, metadata)?;
    Ok(CodexExecutableIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        birth_seconds,
        birth_nanoseconds,
        content_digest: digest_open_executable(file)?,
    })
}

#[cfg(target_os = "macos")]
fn executable_birth_identity(
    file: &std::fs::File,
    _metadata: &std::fs::Metadata,
) -> Result<(i64, i64), String> {
    use std::os::fd::AsRawFd;
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(file.as_raw_fd(), &mut stat) } != 0 {
        return Err("Codex executable vnode birth identity is unavailable".into());
    }
    Ok((stat.st_birthtime, stat.st_birthtime_nsec))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn executable_birth_identity(
    _file: &std::fs::File,
    metadata: &std::fs::Metadata,
) -> Result<(i64, i64), String> {
    use std::os::unix::fs::MetadataExt;
    // Linux has no vnode birth-time field. Its ctime pair is only a portable test fallback; the
    // content digest still makes changed bytes and replacement paths fail closed.
    Ok((metadata.ctime(), metadata.ctime_nsec()))
}

#[cfg(not(unix))]
fn codex_executable_identity(
    _file: &std::fs::File,
    _metadata: &std::fs::Metadata,
) -> Result<CodexExecutableIdentity, String> {
    Err("Codex executable descriptor identity is unavailable on this platform".into())
}

fn executable_identity_digest(identity: &CodexExecutableIdentity) -> String {
    digest_codex_provenance(&[
        &identity.device.to_be_bytes(),
        &identity.inode.to_be_bytes(),
        &identity.birth_seconds.to_be_bytes(),
        &identity.birth_nanoseconds.to_be_bytes(),
        identity.content_digest.as_bytes(),
    ])
}

fn digest_codex_provenance(parts: &[&[u8]]) -> String {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part);
    }
    format!("{:x}", digest.finalize())
}

fn failed_codex_compatibility_probe(cli_version: Option<String>) -> CodexSafeProfileCapability {
    CodexSafeProfileCapability {
        available: false,
        cli_version,
        core_controls_verified: false,
        provenance: None,
        receipt_id: None,
        diagnostics: vec![
            "The resolved Codex executable failed the bounded safe-profile compatibility probe."
                .into(),
        ],
    }
}

fn parse_codex_cli_version(output: &str) -> Option<String> {
    let version = output
        .split_whitespace()
        .find_map(|token| token.strip_prefix("codex-cli"))
        .filter(|version| !version.is_empty())
        .or_else(|| {
            let mut tokens = output.split_whitespace();
            while let Some(token) = tokens.next() {
                if token == "codex-cli" {
                    return tokens.next();
                }
            }
            None
        })?;
    parse_semantic_version(version).map(|_| version.to_string())
}

fn parse_semantic_version(version: &str) -> Option<(u64, u64, u64)> {
    let mut components = version.split('.');
    let major = components.next()?.parse().ok()?;
    let minor = components.next()?.parse().ok()?;
    let patch = components.next()?.parse().ok()?;
    if components.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn missing_codex_safe_profile_controls(top_level_help: &str, exec_help: &str) -> Vec<&'static str> {
    let mut missing = Vec::new();
    for control in ["--ask-for-approval", "never", "-c"] {
        if !top_level_help.contains(control) {
            missing.push(control);
        }
    }
    for control in [
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "--json",
        "--output-schema",
        "--skip-git-repo-check",
    ] {
        if !exec_help.contains(control) {
            missing.push(control);
        }
    }
    if !exec_help.contains("read-only") {
        missing.push("read-only sandbox");
    }
    missing
}

struct CodexCompatibilityProbePipe {
    bytes: Vec<u8>,
    exceeded_limit: bool,
    read_failed: bool,
}

fn drain_codex_compatibility_probe_pipe(
    mut reader: impl std::io::Read,
    overflow: Arc<AtomicBool>,
) -> CodexCompatibilityProbePipe {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    let mut exceeded_limit = false;
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                if bytes.len().saturating_add(read)
                    > CODEX_SAFE_PROFILE_COMPATIBILITY_PROBE_MAX_PIPE_BYTES
                {
                    exceeded_limit = true;
                    overflow.store(true, Ordering::SeqCst);
                    continue;
                }
                bytes.extend_from_slice(&buffer[..read]);
            }
            Err(_) => {
                return CodexCompatibilityProbePipe {
                    bytes,
                    exceeded_limit,
                    read_failed: true,
                }
            }
        }
    }
    CodexCompatibilityProbePipe {
        bytes,
        exceeded_limit,
        read_failed: false,
    }
}

// Capability probing has no webview arguments. It uses only the broker-resolved executable and
// fixed version/help argv, bounded drains, an empty temporary working directory, and the same
// process-group cleanup primitive as the launcher. Diagnostics never include raw CLI output.
fn run_bounded_codex_compatibility_probe(
    broker: &CodexSafeProfileBroker,
    executable: &Path,
    arguments: &[&str],
) -> Result<String, String> {
    let probe_root = std::env::temp_dir();
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .current_dir(&probe_root)
        .env_clear()
        .env("PATH", &broker.adopted_login_shell_path)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    let mut child = command
        .spawn()
        .map_err(|_| "could not start the resolved Codex compatibility probe")?;
    let process_group = i32::try_from(child.id()).map_err(|_| "invalid Codex probe process ID")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Codex compatibility probe stdout is unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Codex compatibility probe stderr is unavailable")?;
    let overflow = Arc::new(AtomicBool::new(false));
    let stdout_overflow = Arc::clone(&overflow);
    let stderr_overflow = Arc::clone(&overflow);
    let (stdout_sender, stdout_receiver) = mpsc::channel();
    let (stderr_sender, stderr_receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = stdout_sender.send(drain_codex_compatibility_probe_pipe(
            stdout,
            stdout_overflow,
        ));
    });
    std::thread::spawn(move || {
        let _ = stderr_sender.send(drain_codex_compatibility_probe_pipe(
            stderr,
            stderr_overflow,
        ));
    });

    let deadline = Instant::now() + CODEX_SAFE_PROFILE_COMPATIBILITY_PROBE_TIMEOUT;
    let mut status = None;
    while Instant::now() < deadline && !overflow.load(Ordering::SeqCst) {
        match child.try_wait() {
            Ok(Some(exited)) => {
                status = Some(exited);
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => break,
        }
    }
    if status.is_none() {
        let _ = cleanup_process_group(process_group);
        status = child.wait().ok();
    } else {
        let _ = cleanup_process_group(process_group);
    }

    // A detached child can retain an inherited pipe after group cleanup. The probe must return
    // within its drain deadline rather than waiting forever for that broken process tree.
    let stdout = stdout_receiver
        .recv_timeout(CODEX_SAFE_PROFILE_COMPATIBILITY_PROBE_DRAIN_TIMEOUT)
        .map_err(|_| "Codex compatibility probe stdout drain did not complete")?;
    let stderr = stderr_receiver
        .recv_timeout(CODEX_SAFE_PROFILE_COMPATIBILITY_PROBE_DRAIN_TIMEOUT)
        .map_err(|_| "Codex compatibility probe stderr drain did not complete")?;
    if overflow.load(Ordering::SeqCst)
        || stdout.exceeded_limit
        || stderr.exceeded_limit
        || stdout.read_failed
        || stderr.read_failed
    {
        return Err("Codex compatibility probe output was not bounded and readable".into());
    }
    if !status.is_some_and(|status| status.success()) {
        return Err("Codex compatibility probe did not exit successfully".into());
    }
    String::from_utf8(stdout.bytes)
        .map_err(|_| "Codex compatibility probe output was not valid UTF-8".into())
}

#[cfg(unix)]
fn is_executable_file(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;

    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable_file(_metadata: &std::fs::Metadata) -> bool {
    true
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodexSafeProfileOperation {
    Review,
    Chat,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexSafeProfileStartRequest {
    pub run_id: String,
    // This bounded, app-derived PR identity is queue admission data only. It cannot select a
    // repository, working directory, executable, or any process capability.
    pub pr_key: String,
    // This closed discriminator selects an embedded schema only. It never accepts a schema path,
    // executable, argument, command, tool, or provider configuration from the webview.
    pub operation: CodexSafeProfileOperation,
    pub prompt: String,
    pub model: Option<String>,
    // Capability returns this opaque broker-issued ID. It cannot contain a path, argv, schema,
    // or profile setting and is checked against the broker registry before queue admission.
    pub provenance_receipt_id: String,
}

impl CodexSafeProfileStartRequest {
    fn validate(&self) -> Result<(), String> {
        if !self.run_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        }) || self.run_id.is_empty()
            || self.run_id.len() > 128
        {
            return Err("Codex safe-profile run IDs must be bounded opaque identifiers.".into());
        }
        if self.pr_key.is_empty()
            || self.pr_key.len() > 256
            || !self.pr_key.chars().all(|character| {
                character.is_ascii_alphanumeric()
                    || matches!(character, '.' | '_' | '-' | '/' | '#')
            })
        {
            return Err(
                "Codex safe-profile PR identities must be bounded app-derived keys.".into(),
            );
        }
        if self.prompt.is_empty() || self.prompt.len() > CODEX_SAFE_PROFILE_MAX_PROMPT_BYTES {
            return Err("Codex safe-profile prompts must be non-empty and bounded.".into());
        }
        if self.provenance_receipt_id.is_empty()
            || self.provenance_receipt_id.len() > 128
            || !self.provenance_receipt_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || character == '-' || character == '_'
            })
        {
            return Err(
                "Codex safe-profile provenance receipts must be broker-issued opaque IDs.".into(),
            );
        }
        if self.model.as_ref().is_some_and(|model| {
            model.is_empty()
                || model.len() > CODEX_SAFE_PROFILE_MAX_MODEL_LENGTH
                || !model.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
                })
        }) {
            return Err(
                "Codex safe-profile model IDs must be bounded provider identifiers.".into(),
            );
        }
        Ok(())
    }
}

// These paths are generated by Rust under an app-owned root. They are deliberately not request
// fields, so the webview cannot point Codex at arbitrary config, schema, log, or state locations.
#[derive(Clone, Debug)]
pub struct CodexSafeProfileRunPaths {
    pub root: PathBuf,
    pub config: PathBuf,
    pub state: PathBuf,
    pub logs: PathBuf,
    pub schema: PathBuf,
    // A run-owned copy of bytes read from the verified descriptor. Launch never reuses PATH.
    pub executable: PathBuf,
}

impl CodexSafeProfileRunPaths {
    fn create(
        app_owned_root: &Path,
        request: &CodexSafeProfileStartRequest,
    ) -> Result<Self, String> {
        Self::create_with_config_writer(app_owned_root, request, |path, contents| {
            std::fs::write(path, contents)
        })
    }

    fn create_with_config_writer(
        app_owned_root: &Path,
        request: &CodexSafeProfileStartRequest,
        config_writer: impl FnOnce(&Path, String) -> std::io::Result<()>,
    ) -> Result<Self, String> {
        request.validate()?;
        let profile_root = app_owned_root.join("codex-safe-profile");
        std::fs::create_dir_all(&profile_root)
            .map_err(|error| format!("could not create Codex safe-profile root: {error}"))?;
        let root = profile_root.join(&request.run_id);
        std::fs::create_dir(&root).map_err(|error| {
            format!("could not reserve Codex safe-profile run directory: {error}")
        })?;
        if let Err(error) = std::fs::write(
            root.join(CODEX_SAFE_PROFILE_OWNERSHIP_MARKER),
            format!(
                "{CODEX_SAFE_PROFILE_OWNERSHIP_MARKER_PREFIX}{}\n",
                request.run_id
            ),
        ) {
            let _ = cleanup_codex_safe_profile_reserved_root(
                &profile_root,
                &root,
                &request.run_id,
                false,
            );
            return Err(format!(
                "could not mark Codex safe-profile run directory as app-owned: {error}"
            ));
        }
        let state = root.join("state");
        let logs = root.join("logs");
        let config = root.join("config.toml");
        let schema = root.join("output-schema.json");
        let executable = root.join("codex-verified");
        if let Err(error) =
            std::fs::create_dir_all(&state).and_then(|_| std::fs::create_dir_all(&logs))
        {
            let _ = cleanup_codex_safe_profile_reserved_root(
                &profile_root,
                &root,
                &request.run_id,
                true,
            );
            return Err(format!(
                "could not create Codex safe-profile run directory: {error}"
            ));
        }

        // The CLI receives these same settings as fixed `-c` overrides below. Keeping the
        // generated file beside the run records the app-owned profile without ever accepting a
        // repository or webview-supplied configuration path.
        let config_contents = format!(
            "history.persistence = \"none\"\nlog_dir = {}\nsqlite_home = {}\nweb_search = \"disabled\"\ncheck_for_update_on_startup = false\nmcp_servers = {{}}\nplugins = {{}}\n\n[features]\nhooks = false\nmulti_agent = false\nshell_tool = false\n",
            toml_string(&logs),
            toml_string(&state),
        );
        if let Err(error) = config_writer(&config, config_contents) {
            let _ = cleanup_codex_safe_profile_reserved_root(
                &profile_root,
                &root,
                &request.run_id,
                true,
            );
            return Err(format!(
                "could not write Codex safe-profile config: {error}"
            ));
        }

        Ok(Self {
            root,
            config,
            state,
            logs,
            schema,
            executable,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CodexSafeProfileAdmissionRecord {
    run_id: String,
    // This is lifecycle evidence only. It contains neither a prompt nor an executable path.
    state: CodexSafeProfileAdmissionState,
    provenance_fingerprint: String,
}

// The retained terminal receipt is the only recovery evidence that outlives a cleaned run root.
// `admitted` records whether the run ever reached durable active admission: the webview persists a
// local `running` record only after the admitted event, so an un-admitted receipt has nothing local
// to interrupt and Rust may delete it at once, while an admitted one must survive until the webview
// acknowledges its durably persisted interruption.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CodexSafeProfileTerminalReceipt {
    run_id: String,
    state: CodexSafeProfileAdmissionState,
    provenance_fingerprint: String,
    admitted: bool,
}

// How far a run got before it terminalized. Only an admitted run can have a local `running`
// record, because the webview persists one after the admitted event; a pre-admission terminal has
// nothing local to interrupt. Each terminal path knows its own reach, so this is never re-derived
// from the run root, whose admission record is rewritten as part of terminalizing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CodexSafeProfileAdmissionReach {
    PreAdmission,
    Admitted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum CodexSafeProfileAdmissionState {
    Queued,
    Preparing,
    Active,
    Terminal,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CodexSafeProfileLivenessRecord {
    run_id: String,
    // The broker creates a fresh process group for every provider launch. Persist its ID beside
    // the leader so recovery never mistakes leader exit for full process-tree exit.
    process_group: i32,
    pid: i32,
    process_start_identity: String,
}

// Admission evidence is written before a spawn attempt, after an active admission, and before
// terminal cleanup. Its temporary file is in the already marker-owned run root, so rename is an
// atomic replacement and no prompt, argv, executable path, or raw model output is retained.
fn persist_codex_safe_profile_admission(
    paths: &CodexSafeProfileRunPaths,
    run_id: &str,
    state: CodexSafeProfileAdmissionState,
    provenance: &CodexSafeProfileObservedProvenance,
) -> Result<(), String> {
    let record = CodexSafeProfileAdmissionRecord {
        run_id: run_id.to_string(),
        state,
        provenance_fingerprint: provenance.provenance_fingerprint.clone(),
    };
    let bytes = serde_json::to_vec(&record)
        .map_err(|error| format!("could not encode Codex admission evidence: {error}"))?;
    let path = paths.root.join(CODEX_SAFE_PROFILE_ADMISSION_RECORD);
    let temporary = paths.root.join(".prv-codex-safe-profile-admission.tmp");
    use std::io::Write;
    let mut file = std::fs::File::create(&temporary)
        .map_err(|error| format!("could not persist Codex admission evidence: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("could not persist Codex admission evidence: {error}"))?;
    std::fs::rename(&temporary, &path)
        .map_err(|error| format!("could not commit Codex admission evidence: {error}"))
}

fn verify_codex_safe_profile_admission(
    paths: &CodexSafeProfileRunPaths,
    run_id: &str,
    state: CodexSafeProfileAdmissionState,
    provenance: &CodexSafeProfileObservedProvenance,
) -> Result<(), String> {
    let path = paths.root.join(CODEX_SAFE_PROFILE_ADMISSION_RECORD);
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|_| "could not verify Codex admission evidence")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("could not verify Codex admission evidence".into());
    }
    let record = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<CodexSafeProfileAdmissionRecord>(&bytes).ok())
        .ok_or("could not verify Codex admission evidence")?;
    if record.run_id != run_id
        || record.state != state
        || record.provenance_fingerprint != provenance.provenance_fingerprint
    {
        return Err("could not verify Codex admission evidence".into());
    }
    Ok(())
}

fn persist_and_verify_codex_safe_profile_admission(
    paths: &CodexSafeProfileRunPaths,
    run_id: &str,
    state: CodexSafeProfileAdmissionState,
    provenance: &CodexSafeProfileObservedProvenance,
) -> Result<(), String> {
    #[cfg(test)]
    if state == CodexSafeProfileAdmissionState::Active
        && FAIL_NEXT_DURABLE_ADMISSION_WRITE.with(|fail| fail.replace(false))
    {
        return Err("injected Codex admission evidence write failure".into());
    }
    persist_codex_safe_profile_admission(paths, run_id, state, provenance)?;
    verify_codex_safe_profile_admission(paths, run_id, state, provenance)
}

// This record is written only after the child has a PID and before it can be registered as an
// active provider. The marker remains the authority for the run root; the liveness record only
// proves that a PID still belongs to that marker-owned launch during startup recovery.
// A terminal may be emitted after Rust has cleaned its run root but before the webview has
// persisted the corresponding terminal. Keep only this opaque recovery receipt until bootstrap;
// it intentionally contains no prompt, path, executable bytes, or model output.
fn persist_codex_safe_profile_terminal_recovery(
    paths: &CodexSafeProfileRunPaths,
    run_id: &str,
    provenance: &CodexSafeProfileObservedProvenance,
    reach: CodexSafeProfileAdmissionReach,
) -> Result<(), String> {
    let Some(profile_root) = paths.root.parent() else {
        return Err("Codex terminal recovery root is unavailable".into());
    };
    let directory = profile_root.join(CODEX_SAFE_PROFILE_TERMINAL_RECOVERY_DIRECTORY);
    // A terminal path can run twice (a public terminal event, then the common terminalizer). An
    // already admitted receipt is never downgraded by a later write.
    let admitted = reach == CodexSafeProfileAdmissionReach::Admitted
        || retained_codex_terminal_receipt_is_admitted(&directory, run_id);
    write_codex_safe_profile_terminal_receipt(
        &directory,
        run_id,
        &provenance.provenance_fingerprint,
        admitted,
    )
}

fn retained_codex_terminal_receipt_is_admitted(directory: &Path, run_id: &str) -> bool {
    read_codex_safe_profile_terminal_receipt(&directory.join(run_id), run_id)
        .is_some_and(|receipt| receipt.admitted)
}

fn read_codex_safe_profile_terminal_receipt(
    path: &Path,
    run_id: &str,
) -> Option<CodexSafeProfileTerminalReceipt> {
    std::fs::symlink_metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        .and_then(|_| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<CodexSafeProfileTerminalReceipt>(&bytes).ok())
        .filter(|receipt| {
            receipt.run_id == run_id
                && receipt.state == CodexSafeProfileAdmissionState::Terminal
                && receipt.provenance_fingerprint.len() == 64
                && receipt
                    .provenance_fingerprint
                    .chars()
                    .all(|character| character.is_ascii_hexdigit())
        })
}

fn write_codex_safe_profile_terminal_receipt(
    directory: &Path,
    run_id: &str,
    provenance_fingerprint: &str,
    admitted: bool,
) -> Result<(), String> {
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("could not create Codex terminal recovery directory: {error}"))?;
    let record = CodexSafeProfileTerminalReceipt {
        run_id: run_id.to_string(),
        state: CodexSafeProfileAdmissionState::Terminal,
        provenance_fingerprint: provenance_fingerprint.to_string(),
        admitted,
    };
    let bytes = serde_json::to_vec(&record)
        .map_err(|error| format!("could not encode Codex terminal recovery evidence: {error}"))?;
    let path = directory.join(run_id);
    let temporary = directory.join(format!(".{run_id}.tmp"));
    use std::io::Write;
    let mut file = std::fs::File::create(&temporary)
        .map_err(|error| format!("could not persist Codex terminal recovery evidence: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("could not persist Codex terminal recovery evidence: {error}"))?;
    std::fs::rename(&temporary, &path)
        .map_err(|error| format!("could not commit Codex terminal recovery evidence: {error}"))
}

fn persist_codex_safe_profile_liveness(
    paths: &CodexSafeProfileRunPaths,
    run_id: &str,
    pid: i32,
    process_group: i32,
) -> Result<(), String> {
    // `configure_process_group(0)` makes the child its own group leader. Refuse to record an
    // arbitrary or inherited group: recovery may signal only this broker-owned group.
    if pid <= 0 || process_group != pid || observed_process_group_id(pid) != Some(process_group) {
        return Err("could not prove the started Codex provider owns its process group".into());
    }
    let process_start_identity = process_start_identity(pid)
        .ok_or("could not observe the started Codex provider process identity")?;
    let record = CodexSafeProfileLivenessRecord {
        run_id: run_id.to_string(),
        process_group,
        pid,
        process_start_identity,
    };
    let bytes = serde_json::to_vec(&record)
        .map_err(|error| format!("could not encode Codex provider liveness record: {error}"))?;
    use std::io::Write;
    let path = paths.root.join(CODEX_SAFE_PROFILE_LIVENESS_RECORD);
    let mut file = std::fs::File::create(&path)
        .map_err(|error| format!("could not persist Codex provider liveness record: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("could not persist Codex provider liveness record: {error}"))
}

fn verify_codex_safe_profile_liveness(
    paths: &CodexSafeProfileRunPaths,
    run_id: &str,
    pid: i32,
    process_group: i32,
) -> Result<(), String> {
    let path = paths.root.join(CODEX_SAFE_PROFILE_LIVENESS_RECORD);
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|_| "could not verify Codex provider liveness evidence")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("could not verify Codex provider liveness evidence".into());
    }
    let record = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<CodexSafeProfileLivenessRecord>(&bytes).ok())
        .ok_or("could not verify Codex provider liveness evidence")?;
    if record.run_id != run_id
        || record.pid != pid
        || record.process_group != process_group
        || record.process_start_identity.is_empty()
    {
        return Err("could not verify Codex provider liveness evidence".into());
    }
    Ok(())
}

fn cleanup_codex_safe_profile_paths(paths: &CodexSafeProfileRunPaths) {
    // Terminal cleanup uses the same marker-checked path guard as preparation failures. It never
    // follows a replaced root, a symlink, or an unmarked sibling.
    let Some(profile_root) = paths.root.parent() else {
        return;
    };
    let Some(run_id) = paths.root.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    if cleanup_codex_safe_profile_reserved_root(profile_root, &paths.root, run_id, true).is_ok() {
        // The broker-created profile root has no marker of its own. Removing it only when empty
        // cannot remove an unowned sibling and lets one-shot empty-directory runs prove cleanup.
        let _ = std::fs::remove_dir(profile_root);
    }
}

// A reservation is eligible for cleanup only when it is still the direct, non-symlink child of
// the canonical profile root. After the ownership marker has been written, its exact contents are
// also required. The brief marker-write failure path is the sole unmarked case: the root was just
// created by this call and is still constrained to its exact reserved name.
fn cleanup_codex_safe_profile_reserved_root(
    profile_root: &Path,
    root: &Path,
    run_id: &str,
    require_marker: bool,
) -> Result<(), String> {
    if root.parent() != Some(profile_root) {
        return Err("Codex safe-profile reservation is outside its profile root".into());
    }
    if root.file_name().and_then(|name| name.to_str()) != Some(run_id) {
        return Err("Codex safe-profile reservation does not match its run ID".into());
    }
    let profile_metadata = std::fs::symlink_metadata(profile_root)
        .map_err(|error| format!("could not inspect Codex safe-profile root: {error}"))?;
    if !profile_metadata.is_dir() || profile_metadata.file_type().is_symlink() {
        return Err("Codex safe-profile root is not an app-owned directory".into());
    }
    let canonical_profile_root = profile_root
        .canonicalize()
        .map_err(|error| format!("could not resolve Codex safe-profile root: {error}"))?;
    let root_metadata = std::fs::symlink_metadata(root)
        .map_err(|error| format!("could not inspect Codex safe-profile reservation: {error}"))?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err("Codex safe-profile reservation is not an owned directory".into());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("could not resolve Codex safe-profile reservation: {error}"))?;
    if canonical_root.parent() != Some(canonical_profile_root.as_path()) {
        return Err("Codex safe-profile reservation escapes its profile root".into());
    }
    if require_marker {
        let marker = canonical_root.join(CODEX_SAFE_PROFILE_OWNERSHIP_MARKER);
        let marker_metadata = std::fs::symlink_metadata(&marker).map_err(|error| {
            format!("could not inspect Codex safe-profile ownership marker: {error}")
        })?;
        if !marker_metadata.is_file() || marker_metadata.file_type().is_symlink() {
            return Err("Codex safe-profile ownership marker is not a regular file".into());
        }
        let expected_marker = format!("{CODEX_SAFE_PROFILE_OWNERSHIP_MARKER_PREFIX}{run_id}\n");
        if std::fs::read_to_string(&marker).ok().as_deref() != Some(expected_marker.as_str()) {
            return Err("Codex safe-profile ownership marker does not match its run ID".into());
        }
    }
    std::fs::remove_dir_all(&canonical_root)
        .map_err(|error| format!("could not remove owned Codex safe-profile state: {error}"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PersistedProcessLiveness {
    Dead,
    Matching,
    Mismatched,
    Unknown,
}

fn persisted_process_liveness(record: &CodexSafeProfileLivenessRecord) -> PersistedProcessLiveness {
    match process_start_identity(record.pid) {
        Some(identity) if identity == record.process_start_identity => {
            PersistedProcessLiveness::Matching
        }
        Some(_) => PersistedProcessLiveness::Mismatched,
        // A PID stays occupied by an exited process until its exit status is collected, so it cannot
        // have been reused in the meantime. Such a process is dead rather than unobservable, and the
        // group-absence proof in every caller still gates any cleanup.
        None if process_is_confirmed_dead(record.pid)
            || process_is_awaiting_collection(record.pid) =>
        {
            PersistedProcessLiveness::Dead
        }
        None => PersistedProcessLiveness::Unknown,
    }
}

#[cfg(target_os = "macos")]
fn process_is_awaiting_collection(pid: i32) -> bool {
    darwin_process_is_awaiting_collection(pid) == Some(true)
}

// Other Unix targets keep describing an exited process until it is collected, so their identity
// read already resolves this case and no separate observation is needed.
#[cfg(not(target_os = "macos"))]
fn process_is_awaiting_collection(_pid: i32) -> bool {
    false
}

fn process_is_confirmed_dead(pid: i32) -> bool {
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid, 0) };
        result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

fn observed_process_group_id(pid: i32) -> Option<i32> {
    #[cfg(unix)]
    {
        let process_group = unsafe { libc::getpgid(pid) };
        (process_group > 0).then_some(process_group)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        None
    }
}

#[cfg(target_os = "linux")]
fn process_start_identity(pid: i32) -> Option<String> {
    // `/proc/<pid>/stat` field 22 is the kernel start tick. It changes on PID reuse and is read
    // directly rather than trusting a mutable process name or caller-provided PID.
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let closing_name = stat.rfind(')')?;
    let start_ticks = stat[closing_name + 2..].split_whitespace().nth(19)?;
    Some(start_ticks.to_string())
}

// The ABI shape of Darwin's `struct proc_bsdinfo` returned for `PROC_PIDTBSDINFO`. Its process
// names, UID/GID, status, flags, file count, and priority are mutable and must never enter a PID
// identity. Keep this representation exact so a short or changed kernel record fails closed.
#[repr(C)]
#[derive(Clone, Copy)]
struct DarwinProcBsdInfo {
    pbi_flags: u32,
    pbi_status: u32,
    pbi_xstatus: u32,
    pbi_pid: u32,
    pbi_ppid: u32,
    pbi_uid: u32,
    pbi_gid: u32,
    pbi_ruid: u32,
    pbi_rgid: u32,
    pbi_svuid: u32,
    pbi_svgid: u32,
    rfu_1: u32,
    pbi_comm: [u8; 16],
    pbi_name: [u8; 32],
    pbi_nfiles: u32,
    pbi_pgid: u32,
    pbi_pjobc: u32,
    e_tdev: u32,
    e_tpgid: u32,
    pbi_nice: i32,
    pbi_start_tvsec: u64,
    pbi_start_tvusec: u64,
}

const DARWIN_PROC_BSDINFO_SIZE: usize = 136;

// `pbi_status` is the kernel's process state. It is read from the same exact-size record as the
// birth identity so one ABI check covers both, and it is never mixed into an identity digest.
fn darwin_status_from_exact_record(record: &[u8]) -> Option<u32> {
    if record.len() != DARWIN_PROC_BSDINFO_SIZE
        || std::mem::size_of::<DarwinProcBsdInfo>() != DARWIN_PROC_BSDINFO_SIZE
    {
        return None;
    }
    // The exact byte count has been checked before this unaligned ABI read.
    let info = unsafe { std::ptr::read_unaligned(record.as_ptr().cast::<DarwinProcBsdInfo>()) };
    Some(info.pbi_status)
}

fn darwin_birth_identity_from_exact_record(record: &[u8]) -> Option<String> {
    if record.len() != DARWIN_PROC_BSDINFO_SIZE
        || std::mem::size_of::<DarwinProcBsdInfo>() != DARWIN_PROC_BSDINFO_SIZE
    {
        return None;
    }
    // The exact byte count has been checked before this unaligned ABI read. Hash only kernel
    // birth-time fields, never mutable fields from `proc_bsdinfo`.
    let info = unsafe { std::ptr::read_unaligned(record.as_ptr().cast::<DarwinProcBsdInfo>()) };
    let mut birth = [0_u8; 16];
    birth[..8].copy_from_slice(&info.pbi_start_tvsec.to_ne_bytes());
    birth[8..].copy_from_slice(&info.pbi_start_tvusec.to_ne_bytes());
    Some(hex_digest(&birth))
}

// The one kernel read behind every Darwin process observation below. A record of any other size
// is a changed ABI and fails closed rather than being reinterpreted.
#[cfg(target_os = "macos")]
fn darwin_exact_proc_bsdinfo(pid: i32) -> Option<[u8; DARWIN_PROC_BSDINFO_SIZE]> {
    unsafe extern "C" {
        fn proc_pidinfo(
            pid: libc::pid_t,
            flavor: libc::c_int,
            arg: u64,
            buffer: *mut libc::c_void,
            buffersize: libc::c_int,
        ) -> libc::c_int;
    }
    const PROC_PIDTBSDINFO: libc::c_int = 3;
    let mut info = [0_u8; DARWIN_PROC_BSDINFO_SIZE];
    let length = unsafe {
        proc_pidinfo(
            pid,
            PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            i32::try_from(info.len()).ok()?,
        )
    };
    if usize::try_from(length).ok()? != DARWIN_PROC_BSDINFO_SIZE {
        return None;
    }
    Some(info)
}

#[cfg(target_os = "macos")]
fn process_start_identity(pid: i32) -> Option<String> {
    darwin_birth_identity_from_exact_record(&darwin_exact_proc_bsdinfo(pid)?)
}

#[cfg(target_os = "macos")]
fn process_is_individually_signallable(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

// A group member is "awaiting collection" once it has exited and only its exit status is still
// held. macOS exposes that in two ways, and both are needed:
//   * `PROC_PIDTBSDINFO` still describes the process, so `pbi_status` answers directly.
//   * the kernel has stopped describing it, which it does for an exited process. `kill(pid, 0)`
//     then has to prove the PID is still ours to signal rather than another user's live process,
//     because a live member this broker may signal would have received the group signal instead of
//     the `EPERM` that brought us here.
// `None` or `Some(false)` means the member is not provably collectable and is never treated as
// absence.
#[cfg(target_os = "macos")]
fn darwin_process_is_awaiting_collection(pid: i32) -> Option<bool> {
    const SZOMB: u32 = 5;
    let Some(record) = darwin_exact_proc_bsdinfo(pid) else {
        return Some(process_is_confirmed_dead(pid) || process_is_individually_signallable(pid));
    };
    Some(darwin_status_from_exact_record(&record)? == SZOMB)
}

// macOS answers `killpg` with `EPERM` for a process group whose only remaining members are
// unreaped zombies, because no signal can be delivered to any of them. That is a group holding no
// live process, not an unobservable group, so enumerate the members and prove it. Any member that
// is not provably awaiting collection leaves the group unresolved.
#[cfg(target_os = "macos")]
fn darwin_process_group_holds_only_collectable_members(process_group: i32) -> Option<bool> {
    unsafe extern "C" {
        fn proc_listpids(
            kind: u32,
            kind_info: u32,
            buffer: *mut libc::c_void,
            buffersize: libc::c_int,
        ) -> libc::c_int;
    }
    const PROC_PGRP_ONLY: u32 = 2;
    const FIRST_MEMBER_CAPACITY: usize = 64;
    const RETRY_MEMBER_CAPACITY: usize = 4096;

    let group = u32::try_from(process_group).ok()?;
    let mut capacity = FIRST_MEMBER_CAPACITY;
    loop {
        let mut members = vec![0_i32; capacity];
        let buffer_bytes = i32::try_from(std::mem::size_of_val(members.as_slice())).ok()?;
        let written = unsafe {
            proc_listpids(
                PROC_PGRP_ONLY,
                group,
                members.as_mut_ptr().cast(),
                buffer_bytes,
            )
        };
        let written = usize::try_from(written).ok()?;
        if written % std::mem::size_of::<i32>() != 0 {
            return None;
        }
        // A completely filled buffer may have been truncated. Retry once on a larger one rather
        // than judging a process group by a partial membership list.
        if written == usize::try_from(buffer_bytes).ok()? {
            if capacity >= RETRY_MEMBER_CAPACITY {
                return None;
            }
            capacity = RETRY_MEMBER_CAPACITY;
            continue;
        }
        let member_count = written / std::mem::size_of::<i32>();

        return members[..member_count]
            .iter()
            .copied()
            .filter(|pid| *pid > 0)
            .try_fold(true, |all_collectable, pid| {
                Some(all_collectable && darwin_process_is_awaiting_collection(pid)?)
            });
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn process_start_identity(_pid: i32) -> Option<String> {
    None
}

fn hex_digest(value: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(value);
    format!("{:x}", digest.finalize())
}

fn terminate_and_wait_matching_process_group(record: &CodexSafeProfileLivenessRecord) -> bool {
    if cleanup_process_group(record.process_group).is_err() {
        return false;
    }
    // A dead leader alone is never recovery proof: the persisted, broker-owned process group
    // must be observed absent as well. PID reuse or an unobservable leader remains unresolved.
    matches!(
        persisted_process_liveness(record),
        PersistedProcessLiveness::Dead
    ) && matches!(process_group_exists(record.process_group), Ok(false))
}

fn safely_resolved_persisted_process(record: &CodexSafeProfileLivenessRecord) -> bool {
    match persisted_process_liveness(record) {
        PersistedProcessLiveness::Matching => terminate_and_wait_matching_process_group(record),
        PersistedProcessLiveness::Dead => {
            // The leader may have exited while a child retains the broker-owned group. Retain
            // marker/admission evidence until an independent group-liveness probe observes none.
            matches!(process_group_exists(record.process_group), Ok(false))
        }
        PersistedProcessLiveness::Mismatched | PersistedProcessLiveness::Unknown => false,
    }
}

// Startup recovery receives only the app-data root, never a webview path. A marker-owned root is
// removed only after its persisted PID/start identity proves dead, or after the exact live process
// is terminated and observed dead. PID reuse, absent/corrupt evidence, and symlinks remain intact.
pub fn recover_codex_safe_profile_transients(app_owned_root: &Path) -> Result<Vec<String>, String> {
    let profile_root = app_owned_root.join("codex-safe-profile");
    if !profile_root.exists() {
        return Ok(Vec::new());
    }
    let profile_metadata = std::fs::symlink_metadata(&profile_root)
        .map_err(|error| format!("could not inspect Codex safe-profile root: {error}"))?;
    if !profile_metadata.is_dir() || profile_metadata.file_type().is_symlink() {
        return Err("Codex safe-profile root is not an app-owned directory".into());
    }
    let canonical_profile_root = profile_root
        .canonicalize()
        .map_err(|error| format!("could not resolve Codex safe-profile root: {error}"))?;
    let mut safely_resolved_run_ids = Vec::new();
    // Terminal receipts outlive only their cleaned run root. An un-admitted receipt has no local
    // record to interrupt, so it is consumed here; an admitted one is reported but retained until
    // the webview acknowledges its durably persisted interruption, and is therefore reported again
    // on every later startup until then. Symlinked and malformed evidence is left untouched.
    let terminal_directory =
        canonical_profile_root.join(CODEX_SAFE_PROFILE_TERMINAL_RECOVERY_DIRECTORY);
    if let Ok(metadata) = std::fs::symlink_metadata(&terminal_directory) {
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            if let Ok(entries) = std::fs::read_dir(&terminal_directory) {
                for entry in entries.flatten() {
                    let run_id = entry.file_name().to_string_lossy().into_owned();
                    if !is_opaque_codex_safe_profile_run_id(&run_id) {
                        continue;
                    }
                    // A terminal receipt beside a still-present run root is only evidence that
                    // terminalization began. Its liveness record remains authoritative until the
                    // owned process group is independently observed absent below.
                    if canonical_profile_root.join(&run_id).exists() {
                        continue;
                    }
                    let path = entry.path();
                    let Some(receipt) = read_codex_safe_profile_terminal_receipt(&path, &run_id)
                    else {
                        continue;
                    };
                    if receipt.admitted {
                        safely_resolved_run_ids.push(run_id);
                        continue;
                    }
                    if std::fs::remove_file(&path).is_ok() {
                        safely_resolved_run_ids.push(run_id);
                    }
                }
            }
        }
    }
    for entry in std::fs::read_dir(&canonical_profile_root)
        .map_err(|error| format!("could not read Codex safe-profile root: {error}"))?
    {
        let entry = entry
            .map_err(|error| format!("could not inspect Codex safe-profile state: {error}"))?;
        let run_id = entry.file_name().to_string_lossy().into_owned();
        if !is_opaque_codex_safe_profile_run_id(&run_id) {
            continue;
        }
        let candidate = entry.path();
        let metadata = match std::fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => metadata,
            _ => continue,
        };
        let _ = metadata;
        let canonical_candidate = match candidate.canonicalize() {
            Ok(path) if path.parent() == Some(canonical_profile_root.as_path()) => path,
            _ => continue,
        };
        let marker = canonical_candidate.join(CODEX_SAFE_PROFILE_OWNERSHIP_MARKER);
        let marker_metadata = match std::fs::symlink_metadata(&marker) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => metadata,
            _ => continue,
        };
        let _ = marker_metadata;
        let expected_marker = format!("{CODEX_SAFE_PROFILE_OWNERSHIP_MARKER_PREFIX}{run_id}\n");
        if std::fs::read_to_string(&marker).ok().as_deref() != Some(expected_marker.as_str()) {
            continue;
        }
        let admission_path = canonical_candidate.join(CODEX_SAFE_PROFILE_ADMISSION_RECORD);
        let admission_metadata = match std::fs::symlink_metadata(&admission_path) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => metadata,
            _ => continue,
        };
        let _ = admission_metadata;
        let admission = match std::fs::read(&admission_path).ok().and_then(|bytes| {
            serde_json::from_slice::<CodexSafeProfileAdmissionRecord>(&bytes).ok()
        }) {
            Some(record)
                if record.run_id == run_id
                    && record.provenance_fingerprint.len() == 64
                    && record
                        .provenance_fingerprint
                        .chars()
                        .all(|character| character.is_ascii_hexdigit()) =>
            {
                record
            }
            _ => continue,
        };
        // Queued/preparing work has no child and no local running record because the webview
        // cannot persist before Rust acknowledges admission. It is therefore safely terminal on
        // restart. `spawning` deliberately does not take this path: its liveness is unresolved
        // until S89's group proof and must retain its marker-owned evidence.
        if matches!(
            admission.state,
            CodexSafeProfileAdmissionState::Queued | CodexSafeProfileAdmissionState::Preparing
        ) {
            cleanup_codex_safe_profile_reserved_root(
                &canonical_profile_root,
                &canonical_candidate,
                &run_id,
                true,
            )?;
            safely_resolved_run_ids.push(run_id);
            continue;
        }
        // A terminal control may still have a dead leader with a live owned descendant. It uses
        // the same liveness/group-absence proof as an active control; terminal state alone is
        // never permission to delete marker-owned evidence or project an interruption.
        let liveness_path = canonical_candidate.join(CODEX_SAFE_PROFILE_LIVENESS_RECORD);
        let liveness_metadata = match std::fs::symlink_metadata(&liveness_path) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => metadata,
            _ => continue,
        };
        let _ = liveness_metadata;
        let record = match std::fs::read(&liveness_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<CodexSafeProfileLivenessRecord>(&bytes).ok())
        {
            Some(record)
                if record.run_id == run_id
                    && record.pid > 0
                    && record.process_group > 0
                    && record.process_group == record.pid
                    && !record.process_start_identity.is_empty() =>
            {
                record
            }
            _ => continue,
        };
        if !safely_resolved_persisted_process(&record) {
            continue;
        }
        // This run was admitted, so the webview may hold a local `running` record for it. Removing
        // the root here would otherwise destroy the last interruption evidence, so make sure a
        // retained receipt exists first; it survives until the webview acknowledges recovery.
        if !terminal_directory.join(&run_id).exists() {
            write_codex_safe_profile_terminal_receipt(
                &terminal_directory,
                &run_id,
                &admission.provenance_fingerprint,
                true,
            )?;
        }
        cleanup_codex_safe_profile_reserved_root(
            &canonical_profile_root,
            &canonical_candidate,
            &run_id,
            true,
        )?;
        safely_resolved_run_ids.push(run_id);
    }
    Ok(safely_resolved_run_ids)
}

// Startup recovery and acknowledgement accept only the opaque broker-generated run-ID shape. A
// caller-supplied ID can therefore never reach a path outside the app-owned terminal directory.
fn is_opaque_codex_safe_profile_run_id(run_id: &str) -> bool {
    !run_id.is_empty()
        && run_id.len() <= 128
        && run_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
}

// Rust keeps an admitted run's terminal receipt until the webview reports that it has durably
// persisted the interruption. Only an ID that this startup's recovery itself resolved can be
// acknowledged, so the webview can neither invent evidence to delete nor reach a run root.
pub fn acknowledge_codex_safe_profile_recovered_runs(
    app_owned_root: &Path,
    recovery: &CodexSafeProfileStartupRecovery,
    run_ids: &[String],
) {
    let terminal_directory = app_owned_root
        .join("codex-safe-profile")
        .join(CODEX_SAFE_PROFILE_TERMINAL_RECOVERY_DIRECTORY);
    for run_id in run_ids {
        if !is_opaque_codex_safe_profile_run_id(run_id) {
            continue;
        }
        if !recovery.is_safely_resolved(run_id) {
            continue;
        }
        let path = terminal_directory.join(run_id);
        let removable = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata.is_file() && !metadata.file_type().is_symlink(),
            // An already-absent receipt is acknowledged work, not a failure.
            Err(_) => {
                recovery.forget_safely_resolved(run_id);
                continue;
            }
        };
        if !removable {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            recovery.forget_safely_resolved(run_id);
        }
    }
}

fn toml_string(path: &Path) -> String {
    format!(
        "\"{}\"",
        path.to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
    )
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSafeProfileCapability {
    pub available: bool,
    // Observed only from the broker-resolved executable's bounded `--version` probe.
    pub cli_version: Option<String>,
    pub core_controls_verified: bool,
    // Digests and version are observed by Rust; no executable path is disclosed.
    pub provenance: Option<CodexSafeProfileObservedProvenance>,
    // Opaque broker registry key. A caller cannot manufacture a valid receipt or select its
    // executable identity; launch re-probes and compares the retained verified record.
    pub receipt_id: Option<String>,
    pub diagnostics: Vec<String>,
}

// This is intentionally the only S53 webview command. Capability inspection accepts no caller
// data and returns no executable path. S54 adds typed start/cancel operations backed by the fixed
// request above; neither generic process execution nor legacy discovery/probe is reintroduced.
#[tauri::command]
pub fn codex_safe_profile_capability(
    broker: tauri::State<'_, CodexSafeProfileBroker>,
) -> CodexSafeProfileCapability {
    broker.capability()
}

#[tauri::command]
pub fn codex_safe_profile_safely_recovered_run_ids(
    recovery: tauri::State<'_, CodexSafeProfileStartupRecovery>,
) -> Vec<String> {
    recovery.safely_resolved_run_ids()
}

// The webview calls this only after its own storage has durably recorded the interruption for an
// ID this startup's recovery reported. It accepts no path and no unknown ID, and never touches a
// run root: an unacknowledged receipt simply reappears in the next startup's recovery.
#[tauri::command]
pub fn codex_safe_profile_acknowledge_recovered_runs(
    app: tauri::AppHandle,
    recovery: tauri::State<'_, CodexSafeProfileStartupRecovery>,
    run_ids: Vec<String>,
) -> Result<(), String> {
    let app_owned_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("could not resolve the app-owned data root: {error}"))?;
    acknowledge_codex_safe_profile_recovered_runs(&app_owned_root, &recovery, &run_ids);
    Ok(())
}

// Jira MCP declarations are configuration data, not authority. Until a local declaration names a
// schema-validated read-only tool and broker-controlled startup/tool-call path, no Jira server is
// started and no network or Jira operation can be requested from the webview.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum JiraMcpReadCapabilityStatus {
    Unavailable,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraMcpReadCapabilityDiagnostic {
    pub status: JiraMcpReadCapabilityStatus,
    pub server: Option<String>,
    pub tool: Option<String>,
    pub diagnostics: Vec<String>,
}

pub fn jira_mcp_read_capability_diagnostic() -> JiraMcpReadCapabilityDiagnostic {
    JiraMcpReadCapabilityDiagnostic {
        status: JiraMcpReadCapabilityStatus::Unavailable,
        server: None,
        tool: None,
        diagnostics: vec![
            "Installed Jira MCP declarations and tool schemas have not been proven locally.".into(),
            "No broker-approved read-only Jira tool is available.".into(),
            "Jira retrieval remains disabled; code review can continue without Jira requirements."
                .into(),
        ],
    }
}

#[cfg(unix)]
fn process_group_exists(process_group: i32) -> Result<bool, String> {
    let result = unsafe { libc::killpg(process_group, 0) };
    if result == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(false);
    }
    // An `EPERM` group whose every member is only awaiting collection holds no live process. Every
    // other permission or observation error stays unresolved, so callers keep their evidence.
    #[cfg(target_os = "macos")]
    if error.raw_os_error() == Some(libc::EPERM)
        && darwin_process_group_holds_only_collectable_members(process_group) == Some(true)
    {
        return Ok(false);
    }
    Err(format!("could not inspect broker process tree: {error}"))
}

#[cfg(not(unix))]
fn process_group_exists(_process_group: i32) -> Result<bool, String> {
    Ok(false)
}

fn wait_for_process_group_exit(process_group: i32, deadline: Instant) -> Result<bool, String> {
    while Instant::now() < deadline {
        match process_group_exists(process_group) {
            Ok(false) => return Ok(true),
            Ok(true) => std::thread::sleep(Duration::from_millis(10)),
            // A permission or observation error is not evidence that the group is empty. Keep
            // marker/admission evidence rather than treating an unobservable descendant as dead.
            Err(error) => return Err(error),
        }
    }
    Ok(false)
}

fn cleanup_process_group(process_group: i32) -> Result<(), String> {
    // Signalling first avoids a parent-exit race: an already empty group returns success through
    // signal_process_tree's ESRCH handling, while a surviving descendant receives the same TERM.
    signal_process_tree(process_group, libc_signal_term())?;
    if wait_for_process_group_exit(process_group, Instant::now() + PROCESS_TERMINATION_GRACE)? {
        return Ok(());
    }

    signal_process_tree(process_group, libc_signal_kill())?;
    if wait_for_process_group_exit(process_group, Instant::now() + PROCESS_KILL_GRACE)? {
        Ok(())
    } else {
        Err("process group remained alive after SIGKILL".into())
    }
}

// Process orchestration remains Rust-owned. This internal core intentionally accepts a Command
// only from broker code; no Tauri command accepts a program or argument list from the webview.
// Real provider adapters remain unavailable until the safety proofs in design §19 are complete.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AiBrokerEvent {
    Started { run_id: String },
    Stdout { run_id: String, line: String },
    Stderr { run_id: String, line: String },
    TimedOut { run_id: String },
    Cancelled { run_id: String },
    OutputLimitExceeded { run_id: String },
    Exited { run_id: String, success: bool },
}

#[derive(Clone)]
struct AiBrokerCancellation {
    process_group: i32,
    cancelled: Arc<AtomicBool>,
}

impl AiBrokerCancellation {
    fn cancel(&self) -> Result<(), String> {
        self.cancelled.store(true, Ordering::SeqCst);
        signal_process_tree(self.process_group, libc_signal_term())
    }
}

// Only sanitized lifecycle progress and a bounded, output-schema-shaped terminal object leave
// the broker. Raw stdout/stderr, provider configuration, paths, and environment values are never
// forwarded to the webview.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSafeProfileUsage {
    pub elapsed_ms: u64,
    // Shell tools are fixed disabled in this profile, so this broker-observed count is always
    // zero unless a future Rust-owned profile adds a separately proven tool event boundary.
    pub tool_event_count: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum CodexSafeProfileEvent {
    Queued {
        run_id: String,
    },
    // The broker emits this only after the queue's cancellable preparation is registered as an
    // active admission. It contains observed provenance but no path, prompt, or process handle.
    Admitted {
        run_id: String,
        provenance: CodexSafeProfileObservedProvenance,
    },
    Started {
        run_id: String,
        provenance: Option<CodexSafeProfileObservedProvenance>,
    },
    Progress {
        run_id: String,
    },
    Completed {
        run_id: String,
        result: serde_json::Value,
        usage: CodexSafeProfileUsage,
        provenance: Option<CodexSafeProfileObservedProvenance>,
    },
    Failed {
        run_id: String,
        code: String,
        provenance: Option<CodexSafeProfileObservedProvenance>,
    },
}

pub struct CodexSafeProfileRun {
    pub events: Receiver<CodexSafeProfileEvent>,
    cancellation: AiBrokerCancellation,
}

impl CodexSafeProfileRun {
    pub fn cancel(&self) -> Result<(), String> {
        self.cancellation.cancel()
    }
}

#[derive(Clone)]
struct QueuedCodexSafeProfileRun {
    request: CodexSafeProfileStartRequest,
    paths: CodexSafeProfileRunPaths,
    verified_launch: VerifiedCodexLaunch,
}

// This is the only production lifecycle record for a Codex request. The FIFO scheduler tracks
// capacity and order only; it never owns a second pending/preparing/active lifecycle map.
struct CodexSafeProfileControl {
    run: QueuedCodexSafeProfileRun,
    state: CodexSafeProfileAdmissionState,
    cancellation_latch: Arc<AtomicBool>,
    cancellation: Option<AiBrokerCancellation>,
}

struct CodexSafeProfileRunState {
    queue: AiBrokerQueue,
    controls: HashMap<String, CodexSafeProfileControl>,
    published_terminals: VecDeque<String>,
    shutting_down: bool,
}

impl CodexSafeProfileRunState {
    // True the first time this run's terminal is published. The record is kept, not the control, so
    // nothing that holds prompt bytes, reserved paths, or an executable descriptor has to survive a
    // settled run just to keep its terminal unique.
    fn claim_terminal_publication(&mut self, run_id: &str) -> bool {
        if self
            .published_terminals
            .iter()
            .any(|published_run_id| published_run_id == run_id)
        {
            return false;
        }
        while self.published_terminals.len() >= CODEX_SAFE_PROFILE_PUBLISHED_TERMINAL_HISTORY {
            self.published_terminals.pop_front();
        }
        self.published_terminals.push_back(run_id.to_string());
        true
    }
}

// Production review and chat admission share this Rust-owned state. A run becomes active only
// after the queue admits it; queued work has no child process or cancellation handle to expose.
pub struct CodexSafeProfileActiveRuns {
    state: Mutex<CodexSafeProfileRunState>,
}

// Startup computes these IDs before the webview exists. The no-argument getter lets local run
// storage interrupt only broker-resolved Codex records whose marker-owned process state was safely
// cleaned; it never accepts a PID, path, or caller-selected run ID.
pub struct CodexSafeProfileStartupRecovery {
    safely_resolved_run_ids: Mutex<Vec<String>>,
}

impl CodexSafeProfileStartupRecovery {
    pub fn replace_safely_resolved_run_ids(&self, run_ids: Vec<String>) {
        if let Ok(mut stored) = self.safely_resolved_run_ids.lock() {
            *stored = run_ids;
        }
    }

    fn safely_resolved_run_ids(&self) -> Vec<String> {
        self.safely_resolved_run_ids
            .lock()
            .map(|stored| stored.clone())
            .unwrap_or_default()
    }

    fn is_safely_resolved(&self, run_id: &str) -> bool {
        self.safely_resolved_run_ids
            .lock()
            .is_ok_and(|stored| stored.iter().any(|stored_run_id| stored_run_id == run_id))
    }

    fn forget_safely_resolved(&self, run_id: &str) {
        if let Ok(mut stored) = self.safely_resolved_run_ids.lock() {
            stored.retain(|stored_run_id| stored_run_id != run_id);
        }
    }
}

impl Default for CodexSafeProfileStartupRecovery {
    fn default() -> Self {
        Self {
            safely_resolved_run_ids: Mutex::new(Vec::new()),
        }
    }
}

impl Default for CodexSafeProfileActiveRuns {
    fn default() -> Self {
        Self {
            state: Mutex::new(CodexSafeProfileRunState {
                queue: AiBrokerQueue::new(2, 1).expect("fixed Codex queue limits are valid"),
                controls: HashMap::new(),
                published_terminals: VecDeque::new(),
                shutting_down: false,
            }),
        }
    }
}

impl CodexSafeProfileActiveRuns {
    fn enqueue(
        &self,
        request: CodexSafeProfileStartRequest,
        paths: CodexSafeProfileRunPaths,
        verified_launch: VerifiedCodexLaunch,
    ) -> Result<AiBrokerQueueState, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Codex safe-profile active-run state is unavailable")?;
        if state.shutting_down {
            return Err("Codex safe-profile broker is shutting down".into());
        }
        if state.controls.contains_key(&request.run_id) {
            return Err("broker run id is already known".into());
        }
        let queue_state = state
            .queue
            .enqueue(request.run_id.clone(), request.pr_key.clone())?;
        let admission_state = match queue_state {
            // This is the atomic dequeue-to-preparing transition. The latch is created in the
            // same critical section, before the launcher can observe the request.
            AiBrokerQueueState::Started => CodexSafeProfileAdmissionState::Preparing,
            AiBrokerQueueState::Queued => CodexSafeProfileAdmissionState::Queued,
        };
        state.controls.insert(
            request.run_id.clone(),
            CodexSafeProfileControl {
                run: QueuedCodexSafeProfileRun {
                    request,
                    paths,
                    verified_launch,
                },
                state: admission_state,
                cancellation_latch: Arc::new(AtomicBool::new(false)),
                cancellation: None,
            },
        );
        Ok(queue_state)
    }

    fn begin_preparing(&self, run_id: &str) -> Result<Arc<AtomicBool>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Codex safe-profile active-run state is unavailable")?;
        let Some(control) = state.controls.get(run_id) else {
            return Err("Codex safe-profile run is not admitted for preparation".into());
        };
        if state.shutting_down || control.state != CodexSafeProfileAdmissionState::Preparing {
            return Err("Codex safe-profile run is not admitted for preparation".into());
        }
        Ok(control.cancellation_latch.clone())
    }

    fn register_active(
        &self,
        run_id: &str,
        cancellation: AiBrokerCancellation,
        preparing: &Arc<AtomicBool>,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Codex safe-profile active-run state is unavailable")?;
        let shutting_down = state.shutting_down;
        let Some(control) = state.controls.get_mut(run_id) else {
            return Err("Codex safe-profile run is not admitted for launch".into());
        };
        if shutting_down
            || control.state != CodexSafeProfileAdmissionState::Preparing
            || preparing.load(Ordering::SeqCst)
            || !Arc::ptr_eq(&control.cancellation_latch, preparing)
        {
            return Err(
                "Codex safe-profile run was cancelled or is not admitted for launch".into(),
            );
        }
        control.state = CodexSafeProfileAdmissionState::Active;
        control.cancellation = Some(cancellation);
        Ok(())
    }

    // Returns true only when cancellation terminalizes work that has no child. Preparing work
    // remains owned by its launcher, which observes the same latch and releases its FIFO slot.
    fn cancel(&self, run_id: &str) -> Result<bool, String> {
        let cancellation = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Codex safe-profile active-run state is unavailable")?;
            let Some(control) = state.controls.get(run_id) else {
                return Err("Codex safe-profile run is not active, preparing, or queued".into());
            };
            match control.state {
                CodexSafeProfileAdmissionState::Active => control.cancellation.clone(),
                CodexSafeProfileAdmissionState::Preparing => {
                    // The caller publishes this run's one `cancelled` terminal, and its launcher
                    // sees the same latch and releases the FIFO slot. A repeated cancellation
                    // latches again but must not publish a second terminal.
                    let publishes = state.claim_terminal_publication(run_id);
                    let control = state
                        .controls
                        .get_mut(run_id)
                        .expect("checked control exists");
                    control.cancellation_latch.store(true, Ordering::SeqCst);
                    return Ok(publishes);
                }
                CodexSafeProfileAdmissionState::Queued => {
                    if !state.queue.cancel_pending(run_id) {
                        return Err("Codex safe-profile queued run was not pending".into());
                    }
                    // No launcher ever observed this control, so nothing can latch it and nothing
                    // may keep its prompt, reserved paths, or executable descriptor alive.
                    let publishes = state.claim_terminal_publication(run_id);
                    state.controls.remove(run_id);
                    return Ok(publishes);
                }
                CodexSafeProfileAdmissionState::Terminal => {
                    return Err("Codex safe-profile run is already terminal".into())
                }
            }
        };
        if let Some(cancellation) = cancellation {
            cancellation.cancel()?;
            Ok(false)
        } else {
            Ok(true)
        }
    }

    // The launcher calls this before publishing a pre-admission terminal. A public cancellation
    // of queued or preparing work has already published that run's single terminal, so claiming it
    // twice must yield exactly one public event. An unknown control or an unavailable registry
    // still publishes, because swallowing the only terminal would leave the webview waiting.
    fn claim_terminal_publication(&self, run_id: &str) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return true;
        };
        state.claim_terminal_publication(run_id)
    }

    fn release(&self, run_id: &str) -> Result<Option<QueuedCodexSafeProfileRun>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Codex safe-profile active-run state is unavailable")?;
        // A settled run's control holds its full prompt, its reserved run paths, and an open
        // descriptor for the verified executable. None of that may outlive the run, so the whole
        // entry goes; its bounded publication record is what keeps the terminal unique.
        if state.controls.remove(run_id).is_none() {
            return Ok(None);
        }
        let Some(next_run_id) = state.queue.release(run_id) else {
            return Ok(None);
        };
        let next = state
            .controls
            .get_mut(&next_run_id)
            .ok_or("Codex safe-profile FIFO control is missing")?;
        if next.state != CodexSafeProfileAdmissionState::Queued {
            return Err("Codex safe-profile FIFO control is not queued".into());
        }
        next.state = CodexSafeProfileAdmissionState::Preparing;
        Ok(Some(next.run.clone()))
    }

    // A durable admission failure occurs after a child may exist but before the run is active.
    // Terminalizing the control and releasing its FIFO slot in one mutex transaction prevents a
    // monitor or retry path from observing a half-admitted record.
    fn fail_preparing_and_release(
        &self,
        run_id: &str,
    ) -> Result<Option<QueuedCodexSafeProfileRun>, String> {
        self.release(run_id)
    }

    // Desktop exit is broker-owned process cleanup, not a best-effort webview cancellation. It
    // latches every non-terminal control before synchronously terminating admitted process groups.
    pub fn shutdown(&self) -> Result<(), String> {
        let active = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Codex safe-profile active-run state is unavailable")?;
            state.shutting_down = true;
            // Draining the map latches every launcher and drops every retained prompt, reserved
            // path, and executable descriptor as part of exit rather than leaving them resident.
            let active = state
                .controls
                .drain()
                .filter_map(|(_, control)| {
                    control.cancellation_latch.store(true, Ordering::SeqCst);
                    control.cancellation
                })
                .collect::<Vec<_>>();
            state.queue.active.clear();
            state.queue.pending.clear();
            active
        };
        let mut cleanup_error = None;
        for cancellation in active {
            cancellation.cancelled.store(true, Ordering::SeqCst);
            if let Err(error) = cleanup_process_group(cancellation.process_group) {
                cleanup_error.get_or_insert(error);
            }
        }
        cleanup_error.map_or(Ok(()), Err)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSafeProfileStartResponse {
    pub run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexSafeProfileCancelRequest {
    run_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CodexTerminalEnvelope {
    result: serde_json::Value,
}

#[derive(Deserialize)]
struct CodexJsonlItem {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
}

#[derive(Deserialize)]
struct CodexJsonlEvent {
    #[serde(rename = "type")]
    kind: String,
    item: Option<CodexJsonlItem>,
}

// These schemas intentionally enumerate every model-owned terminal field. Coverage and usage do
// not appear: they are derived from the admitted app snapshot and broker observations, never
// accepted from model output. The matching Rust validator below rechecks the schema's strict
// shape before any terminal JSON crosses the process boundary.
const CODEX_SAFE_PROFILE_REVIEW_OUTPUT_SCHEMA: &str = r##"{"type":"object","additionalProperties":false,"required":["result"],"properties":{"result":{"type":"object","additionalProperties":false,"required":["summary","findings","requirementCoverage","reportedModel"],"properties":{"summary":{"type":"string","minLength":1},"findings":{"type":"array","items":{"$ref":"#/$defs/finding"}},"requirementCoverage":{"anyOf":[{"type":"null"},{"$ref":"#/$defs/requirementCoverage"}]},"reportedModel":{"type":["string","null"],"minLength":1}}}},"$defs":{"criterion":{"type":"object","additionalProperties":false,"required":["issueKey","criterion"],"properties":{"issueKey":{"type":"string","minLength":1},"criterion":{"type":"string","minLength":1}}},"finding":{"type":"object","additionalProperties":false,"required":["id","title","severity","confidence","category","path","side","startLine","endLine","evidence","impact","suggestedFix","source","requirementCriterion"],"properties":{"id":{"type":"string","minLength":1},"title":{"type":"string","minLength":1},"severity":{"enum":["critical","high","medium","low"]},"confidence":{"enum":["high","medium","low"]},"category":{"type":"string","minLength":1},"path":{"type":["string","null"],"minLength":1},"side":{"enum":["LEFT","RIGHT",null]},"startLine":{"type":["integer","null"],"minimum":1},"endLine":{"type":["integer","null"],"minimum":1},"evidence":{"type":"string","minLength":1},"impact":{"type":"string","minLength":1},"suggestedFix":{"type":["string","null"],"minLength":1},"source":{"enum":["code-review","requirement-mismatch","chat"]},"requirementCriterion":{"anyOf":[{"type":"null"},{"$ref":"#/$defs/criterion"}]}}},"evidence":{"type":"object","additionalProperties":false,"required":["source","reference","detail"],"properties":{"source":{"enum":["jira","code","test","no-code-evidence"]},"reference":{"type":"string","minLength":1},"detail":{"type":"string","minLength":1}}},"requirementItem":{"type":"object","additionalProperties":false,"required":["issueKey","criterion","state","evidence","reviewerQuestion"],"properties":{"issueKey":{"type":"string","minLength":1},"criterion":{"type":"string","minLength":1},"state":{"enum":["met","partially-met","not-evidenced","contradicted"]},"evidence":{"type":"array","items":{"$ref":"#/$defs/evidence"}},"reviewerQuestion":{"type":["string","null"],"minLength":1}}},"requirementCoverage":{"type":"object","additionalProperties":false,"required":["status","items","unavailableIssueKeys"],"properties":{"status":{"enum":["available","partial","unavailable"]},"items":{"type":"array","items":{"$ref":"#/$defs/requirementItem"}},"unavailableIssueKeys":{"type":"array","items":{"type":"string","minLength":1}}}}}}"##;

const CODEX_SAFE_PROFILE_CHAT_OUTPUT_SCHEMA: &str = r##"{"type":"object","additionalProperties":false,"required":["result"],"properties":{"result":{"type":"object","additionalProperties":false,"required":["message","findingCandidate","reportedModel"],"properties":{"message":{"type":"string","minLength":1},"findingCandidate":{"anyOf":[{"type":"null"},{"$ref":"#/$defs/finding"}]},"reportedModel":{"type":["string","null"],"minLength":1}}}},"$defs":{"criterion":{"type":"object","additionalProperties":false,"required":["issueKey","criterion"],"properties":{"issueKey":{"type":"string","minLength":1},"criterion":{"type":"string","minLength":1}}},"finding":{"type":"object","additionalProperties":false,"required":["id","title","severity","confidence","category","path","side","startLine","endLine","evidence","impact","suggestedFix","source","requirementCriterion"],"properties":{"id":{"type":"string","minLength":1},"title":{"type":"string","minLength":1},"severity":{"enum":["critical","high","medium","low"]},"confidence":{"enum":["high","medium","low"]},"category":{"type":"string","minLength":1},"path":{"type":["string","null"],"minLength":1},"side":{"enum":["LEFT","RIGHT",null]},"startLine":{"type":["integer","null"],"minimum":1},"endLine":{"type":["integer","null"],"minimum":1},"evidence":{"type":"string","minLength":1},"impact":{"type":"string","minLength":1},"suggestedFix":{"type":["string","null"],"minLength":1},"source":{"enum":["code-review","requirement-mismatch","chat"]},"requirementCriterion":{"anyOf":[{"type":"null"},{"$ref":"#/$defs/criterion"}]}}}}}"##;

fn codex_safe_profile_output_schema(operation: CodexSafeProfileOperation) -> &'static str {
    match operation {
        CodexSafeProfileOperation::Review => CODEX_SAFE_PROFILE_REVIEW_OUTPUT_SCHEMA,
        CodexSafeProfileOperation::Chat => CODEX_SAFE_PROFILE_CHAT_OUTPUT_SCHEMA,
    }
}

fn strict_object<'a>(
    value: &'a serde_json::Value,
    required: &[&str],
    optional: &[&str],
) -> Result<&'a serde_json::Map<String, serde_json::Value>, String> {
    let object = value
        .as_object()
        .ok_or("Codex terminal output must contain an object")?;
    if required.iter().any(|field| !object.contains_key(*field))
        || object
            .keys()
            .any(|field| !required.contains(&field.as_str()) && !optional.contains(&field.as_str()))
    {
        return Err(
            "Codex terminal output did not match the complete app-owned output schema".into(),
        );
    }
    Ok(object)
}

fn required_nonempty_string(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<(), String> {
    if object
        .get(field)
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| !value.is_empty())
    {
        Ok(())
    } else {
        Err("Codex terminal output contained an incomplete string field".into())
    }
}

fn nullable_nonempty_string(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<(), String> {
    match object.get(field) {
        Some(serde_json::Value::Null) => Ok(()),
        Some(serde_json::Value::String(value)) if !value.is_empty() => Ok(()),
        _ => Err("Codex terminal output contained an invalid nullable string field".into()),
    }
}

fn required_enum(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
    allowed: &[&str],
) -> Result<(), String> {
    if object
        .get(field)
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| allowed.contains(&value))
    {
        Ok(())
    } else {
        Err("Codex terminal output contained an invalid enum field".into())
    }
}

fn required_array<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<&'a Vec<serde_json::Value>, String> {
    object
        .get(field)
        .and_then(serde_json::Value::as_array)
        .ok_or("Codex terminal output contained an invalid array field".into())
}

fn validate_codex_finding(value: &serde_json::Value) -> Result<(), String> {
    let fields = strict_object(
        value,
        &[
            "id",
            "title",
            "severity",
            "confidence",
            "category",
            "path",
            "side",
            "startLine",
            "endLine",
            "evidence",
            "impact",
            "suggestedFix",
            "source",
            "requirementCriterion",
        ],
        &[],
    )?;
    for field in ["id", "title", "category", "evidence", "impact"] {
        required_nonempty_string(fields, field)?;
    }
    required_enum(fields, "severity", &["critical", "high", "medium", "low"])?;
    required_enum(fields, "confidence", &["high", "medium", "low"])?;
    required_enum(
        fields,
        "source",
        &["code-review", "requirement-mismatch", "chat"],
    )?;
    for field in ["path", "suggestedFix"] {
        nullable_nonempty_string(fields, field)?;
    }
    match fields.get("side") {
        Some(serde_json::Value::Null) => {}
        Some(serde_json::Value::String(value)) if matches!(value.as_str(), "LEFT" | "RIGHT") => {}
        _ => return Err("Codex terminal output contained an invalid finding side".into()),
    }
    for field in ["startLine", "endLine"] {
        match fields.get(field) {
            Some(serde_json::Value::Null) => {}
            Some(value) if value.as_i64().is_some_and(|line| line > 0) => {}
            _ => return Err("Codex terminal output contained an invalid finding line".into()),
        }
    }
    match fields.get("requirementCriterion") {
        Some(serde_json::Value::Null)
            if fields.get("source").and_then(serde_json::Value::as_str)
                != Some("requirement-mismatch") => {}
        Some(criterion) => {
            let criterion = strict_object(criterion, &["issueKey", "criterion"], &[])?;
            required_nonempty_string(criterion, "issueKey")?;
            required_nonempty_string(criterion, "criterion")?;
        }
        _ => {
            return Err("Codex requirement-mismatch findings require a criterion reference".into())
        }
    }
    Ok(())
}

// Codex requires every declared object property in a closed output schema to be required. The
// shared contract intentionally models this reference as optional because only requirement
// mismatches carry it, so strip the required transport null after Rust has validated it.
fn normalize_codex_finding_requirement_criterion(finding: &mut serde_json::Value) {
    if let Some(fields) = finding.as_object_mut() {
        if fields.get("requirementCriterion") == Some(&serde_json::Value::Null) {
            fields.remove("requirementCriterion");
        }
    }
}

fn normalize_codex_terminal_result(
    operation: CodexSafeProfileOperation,
    result: &mut serde_json::Value,
) {
    match operation {
        CodexSafeProfileOperation::Review => {
            if let Some(findings) = result
                .get_mut("findings")
                .and_then(serde_json::Value::as_array_mut)
            {
                for finding in findings {
                    normalize_codex_finding_requirement_criterion(finding);
                }
            }
        }
        CodexSafeProfileOperation::Chat => {
            if let Some(finding) = result.get_mut("findingCandidate") {
                if !finding.is_null() {
                    normalize_codex_finding_requirement_criterion(finding);
                }
            }
        }
    }
}

fn validate_codex_requirement_coverage(value: &serde_json::Value) -> Result<(), String> {
    let coverage = strict_object(value, &["status", "items", "unavailableIssueKeys"], &[])?;
    required_enum(coverage, "status", &["available", "partial", "unavailable"])?;
    for key in required_array(coverage, "unavailableIssueKeys")? {
        if !key.as_str().is_some_and(|value| !value.is_empty()) {
            return Err("Codex terminal output contained an invalid unavailable issue key".into());
        }
    }
    for item in required_array(coverage, "items")? {
        let item = strict_object(
            item,
            &[
                "issueKey",
                "criterion",
                "state",
                "evidence",
                "reviewerQuestion",
            ],
            &[],
        )?;
        required_nonempty_string(item, "issueKey")?;
        required_nonempty_string(item, "criterion")?;
        required_enum(
            item,
            "state",
            &["met", "partially-met", "not-evidenced", "contradicted"],
        )?;
        nullable_nonempty_string(item, "reviewerQuestion")?;
        let mut has_jira = false;
        let mut has_code = false;
        let mut has_no_code = false;
        for evidence in required_array(item, "evidence")? {
            let evidence = strict_object(evidence, &["source", "reference", "detail"], &[])?;
            required_nonempty_string(evidence, "reference")?;
            required_nonempty_string(evidence, "detail")?;
            let source = evidence.get("source").and_then(serde_json::Value::as_str);
            match source {
                Some("jira") => has_jira = true,
                Some("code") | Some("test") => has_code = true,
                Some("no-code-evidence") => has_no_code = true,
                _ => {
                    return Err("Codex terminal output contained an invalid evidence source".into())
                }
            }
        }
        if !has_jira {
            return Err("Codex requirement coverage requires Jira evidence".into());
        }
        if item.get("reviewerQuestion") == Some(&serde_json::Value::Null) {
            let state = item.get("state").and_then(serde_json::Value::as_str);
            if state == Some("not-evidenced") {
                if !has_no_code || has_code {
                    return Err("Codex not-evidenced coverage had invalid evidence".into());
                }
            } else if !has_code || has_no_code {
                return Err("Codex requirement coverage had invalid code evidence".into());
            }
        }
    }
    Ok(())
}

fn validate_codex_terminal_result(
    operation: CodexSafeProfileOperation,
    result: &serde_json::Value,
) -> Result<(), String> {
    match operation {
        CodexSafeProfileOperation::Review => {
            let review = strict_object(
                result,
                &[
                    "summary",
                    "findings",
                    "requirementCoverage",
                    "reportedModel",
                ],
                &[],
            )?;
            required_nonempty_string(review, "summary")?;
            nullable_nonempty_string(review, "reportedModel")?;
            for finding in required_array(review, "findings")? {
                validate_codex_finding(finding)?;
            }
            match review.get("requirementCoverage") {
                Some(serde_json::Value::Null) => Ok(()),
                Some(coverage) => validate_codex_requirement_coverage(coverage),
                None => Err("Codex terminal output omitted requirement coverage".into()),
            }
        }
        CodexSafeProfileOperation::Chat => {
            let chat = strict_object(
                result,
                &["message", "findingCandidate", "reportedModel"],
                &[],
            )?;
            required_nonempty_string(chat, "message")?;
            nullable_nonempty_string(chat, "reportedModel")?;
            match chat.get("findingCandidate") {
                Some(serde_json::Value::Null) => Ok(()),
                Some(finding) => validate_codex_finding(finding),
                None => Err("Codex terminal output omitted finding candidate".into()),
            }
        }
    }
}

// A permission request names only an already-broker-owned action. It deliberately has no program,
// arguments, source text, or execution method: the webview can decide one pending ID, but cannot
// turn that decision into arbitrary process authority.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AiBrokerPermissionKind {
    Command,
    McpStartup,
    McpToolCall,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiBrokerPermissionRequest {
    pub request_id: String,
    pub run_id: String,
    pub kind: AiBrokerPermissionKind,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AiBrokerPermissionDecision {
    AllowOnce,
    Deny,
}

#[derive(Debug)]
struct AiPendingPermissionGate {
    pending: HashMap<String, AiBrokerPermissionRequest>,
}

impl AiPendingPermissionGate {
    fn new() -> Self {
        Self {
            pending: HashMap::new(),
        }
    }

    fn register(&mut self, request: AiBrokerPermissionRequest) -> Result<(), String> {
        if request.request_id.trim().is_empty() || request.run_id.trim().is_empty() {
            return Err("broker permission requests require non-empty request and run IDs".into());
        }
        if self.pending.contains_key(&request.request_id) {
            return Err("broker permission request ID is already pending".into());
        }

        self.pending.insert(request.request_id.clone(), request);
        Ok(())
    }

    // Resolving consumes the pending ID, so an allow-once decision cannot be replayed or become a
    // durable permission. The future launch shell must still enforce its own read-only limits.
    fn resolve(
        &mut self,
        request_id: &str,
        decision: AiBrokerPermissionDecision,
    ) -> Result<(AiBrokerPermissionRequest, AiBrokerPermissionDecision), String> {
        let request = self
            .pending
            .remove(request_id)
            .ok_or("broker permission request is not pending")?;
        Ok((request, decision))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AiBrokerQueueState {
    Started,
    Queued,
}

#[derive(Debug)]
struct QueuedBrokerRun {
    run_id: String,
    pr_key: String,
}

// This pure queue is the concurrency control point used by a future provider-launch bridge.
// It admits at most the configured global count and one configured count per PR; queued work is
// FIFO among runs whose PR currently has capacity.
#[derive(Debug)]
struct AiBrokerQueue {
    global_limit: usize,
    per_pr_limit: usize,
    active: HashMap<String, String>,
    pending: VecDeque<QueuedBrokerRun>,
}

impl AiBrokerQueue {
    fn new(global_limit: usize, per_pr_limit: usize) -> Result<Self, String> {
        if global_limit == 0 || per_pr_limit == 0 {
            return Err("broker concurrency limits must be greater than zero".into());
        }

        Ok(Self {
            global_limit,
            per_pr_limit,
            active: HashMap::new(),
            pending: VecDeque::new(),
        })
    }

    fn enqueue(&mut self, run_id: String, pr_key: String) -> Result<AiBrokerQueueState, String> {
        if self.active.contains_key(&run_id) || self.pending.iter().any(|run| run.run_id == run_id)
        {
            return Err("broker run id is already known".into());
        }

        if self.can_start(&pr_key) {
            self.active.insert(run_id, pr_key);
            return Ok(AiBrokerQueueState::Started);
        }

        self.pending.push_back(QueuedBrokerRun { run_id, pr_key });
        Ok(AiBrokerQueueState::Queued)
    }

    fn release(&mut self, run_id: &str) -> Option<String> {
        self.active.remove(run_id)?;
        let next_index = self
            .pending
            .iter()
            .position(|run| self.can_start(&run.pr_key))?;
        let next = self.pending.remove(next_index)?;
        self.active.insert(next.run_id.clone(), next.pr_key);
        Some(next.run_id)
    }

    fn cancel_pending(&mut self, run_id: &str) -> bool {
        let Some(index) = self.pending.iter().position(|run| run.run_id == run_id) else {
            return false;
        };
        self.pending.remove(index);
        true
    }

    fn can_start(&self, pr_key: &str) -> bool {
        self.active.len() < self.global_limit
            && self
                .active
                .values()
                .filter(|active_pr| active_pr.as_str() == pr_key)
                .count()
                < self.per_pr_limit
    }
}

pub struct AiBrokerRun {
    pub events: Receiver<AiBrokerEvent>,
    cancellation: AiBrokerCancellation,
    // Safe-profile launch keeps this closed until its post-spawn identity checks complete.
    stdin: Arc<Mutex<Option<ChildStdin>>>,
}

impl AiBrokerRun {
    // Cancellation always targets the provider process group, which includes any descendants it
    // launched. The caller cannot choose a PID or a signal.
    pub fn cancel(&self) -> Result<(), String> {
        self.cancellation.cancel()
    }

    fn cancellation(&self) -> AiBrokerCancellation {
        self.cancellation.clone()
    }

    // A failed durable admission must revoke the undisclosed prompt before group cleanup. Taking
    // the broker-owned pipe is synchronous and makes a later stdin disclosure impossible.
    fn close_stdin(&self) {
        if let Ok(mut stdin) = self.stdin.lock() {
            let _ = stdin.take();
        }
    }

    fn disclose_stdin(&self, input: Vec<u8>) -> Result<(), String> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| "provider stdin state is unavailable")?
            .take()
            .ok_or("provider stdin is closed before prompt delivery")?;
        use std::io::Write;
        // Small prompts fit in the kernel pipe and are written before launch reports terminal
        // state; larger bounded contexts stay asynchronous so a non-reading trusted process
        // cannot block the broker thread.
        if input.len() <= 8 * 1024 {
            stdin
                .write_all(&input)
                .map_err(|_| "could not deliver the bounded Codex prompt")?;
        } else {
            std::thread::spawn(move || {
                let _ = stdin.write_all(&input);
            });
        }
        Ok(())
    }
}

fn sanitize_event_line(line: String, max_length: usize) -> String {
    line.chars().take(max_length).collect()
}

struct ChildOutputDrain {
    completed: Receiver<()>,
}

fn stream_child_output(
    mut reader: impl std::io::Read + Send + 'static,
    run_id: String,
    events: Sender<AiBrokerEvent>,
    is_stderr: bool,
    output_line_count: Arc<AtomicUsize>,
    output_byte_count: Arc<AtomicUsize>,
    max_output_lines: usize,
    max_output_bytes: usize,
    output_limit_exceeded: Arc<AtomicBool>,
    output_stopped: Arc<AtomicBool>,
    max_line_length: usize,
) -> ChildOutputDrain {
    let (completed_sender, completed) = mpsc::channel();
    std::thread::spawn(move || {
        // `BufRead::lines` allocates until it finds a newline and hides read/decode failures.
        // Frame raw bytes ourselves so neither a hostile line nor an inherited open pipe can
        // make output handling unbounded. A JSONL stream must end every frame with `\n`.
        let mut frame = Vec::with_capacity(max_line_length.min(8 * 1024));
        let mut buffer = [0_u8; 4096];
        let mut valid = true;
        loop {
            if output_stopped.load(Ordering::SeqCst) {
                break;
            }
            let read = match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => read,
                Err(_) => {
                    valid = false;
                    break;
                }
            };
            if output_byte_count
                .fetch_add(read, Ordering::SeqCst)
                .saturating_add(read)
                > max_output_bytes
            {
                valid = false;
                break;
            }
            for byte in &buffer[..read] {
                if *byte == b'\n' {
                    if output_line_count.fetch_add(1, Ordering::SeqCst) >= max_output_lines {
                        valid = false;
                        break;
                    }
                    let line = match String::from_utf8(std::mem::take(&mut frame)) {
                        Ok(line) => line,
                        Err(_) => {
                            valid = false;
                            break;
                        }
                    };
                    if !output_stopped.load(Ordering::SeqCst) {
                        let event = if is_stderr {
                            AiBrokerEvent::Stderr {
                                run_id: run_id.clone(),
                                line: sanitize_event_line(line, max_line_length),
                            }
                        } else {
                            AiBrokerEvent::Stdout {
                                run_id: run_id.clone(),
                                line: sanitize_event_line(line, max_line_length),
                            }
                        };
                        let _ = events.send(event);
                    }
                } else if frame.len() < max_line_length {
                    frame.push(*byte);
                } else {
                    valid = false;
                    break;
                }
            }
            if !valid {
                break;
            }
        }
        // A partial final frame is truncated JSONL, not a best-effort event. It must fail closed
        // rather than silently accepting an incomplete terminal object.
        if !frame.is_empty() {
            valid = false;
        }
        if !valid {
            // First rejection stops both readers. The monitor immediately bounds process-group
            // cleanup and emits the sole terminal invalid-output event; it never waits for a
            // detached descendant that retained a pipe sender.
            output_stopped.store(true, Ordering::SeqCst);
            output_limit_exceeded.store(true, Ordering::SeqCst);
        }
        let _ = completed_sender.send(());
    });
    ChildOutputDrain { completed }
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn libc_signal_term() -> i32 {
    libc::SIGTERM
}

#[cfg(not(unix))]
fn libc_signal_term() -> i32 {
    0
}

#[cfg(unix)]
fn libc_signal_kill() -> i32 {
    libc::SIGKILL
}

#[cfg(not(unix))]
fn libc_signal_kill() -> i32 {
    0
}

// On Unix the child starts a new process group before exec, so this kills the entire provider
// tree without relying on a shell. The desktop is macOS-only for this release; non-Unix adapters
// cannot be enabled until they provide an equivalent OS-owned tree cleanup mechanism.
#[cfg(unix)]
fn signal_process_tree(process_group: i32, signal: i32) -> Result<(), String> {
    let result = unsafe { libc::killpg(process_group, signal) };
    if result == 0 {
        return Ok(());
    }

    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(format!("could not signal provider process tree: {error}"))
}

#[cfg(not(unix))]
fn signal_process_tree(_process_group: i32, _signal: i32) -> Result<(), String> {
    Err("process-tree cleanup is unavailable on this platform".into())
}

// The launch core is deliberately private until a real adapter has proved every safety control.
// Tests inject only the compiled fake-child fixture; production code has no public launch route.
fn start_broker_process(
    run_id: String,
    command: Command,
    timeout: Duration,
) -> Result<AiBrokerRun, String> {
    start_broker_process_with_input(
        run_id,
        command,
        timeout,
        None,
        BROKER_MAX_OUTPUT_LINES,
        BROKER_MAX_OUTPUT_BYTES,
        BROKER_MAX_EVENT_LINE_LENGTH,
    )
}

fn start_broker_process_with_input(
    run_id: String,
    command: Command,
    timeout: Duration,
    stdin_input: Option<Vec<u8>>,
    max_output_lines: usize,
    max_output_bytes: usize,
    max_line_length: usize,
) -> Result<AiBrokerRun, String> {
    let run = start_broker_process_with_stdin_state(
        run_id,
        command,
        timeout,
        stdin_input.is_some(),
        max_output_lines,
        max_output_bytes,
        max_line_length,
    )?;
    if let Some(input) = stdin_input {
        run.disclose_stdin(input)?;
    }
    Ok(run)
}

// Production Codex uses this variant to prove the materialized executable and spawned PID before
// any untrusted prompt bytes are written. Other broker tests retain the immediate-input wrapper.
fn start_broker_process_with_deferred_input(
    run_id: String,
    command: Command,
    timeout: Duration,
    max_output_lines: usize,
    max_output_bytes: usize,
    max_line_length: usize,
) -> Result<AiBrokerRun, String> {
    start_broker_process_with_stdin_state(
        run_id,
        command,
        timeout,
        true,
        max_output_lines,
        max_output_bytes,
        max_line_length,
    )
}

fn start_broker_process_with_stdin_state(
    run_id: String,
    mut command: Command,
    timeout: Duration,
    stdin_open: bool,
    max_output_lines: usize,
    max_output_bytes: usize,
    max_line_length: usize,
) -> Result<AiBrokerRun, String> {
    configure_process_group(&mut command);
    command
        .stdin(if stdin_open {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("provider process could not start: {error}"))?;
    let process_group = i32::try_from(child.id()).map_err(|_| "provider PID is invalid")?;
    let stdin = if stdin_open {
        Some(
            child
                .stdin
                .take()
                .ok_or("provider stdin pipe is unavailable")?,
        )
    } else {
        None
    };
    let stdout = child
        .stdout
        .take()
        .ok_or("provider stdout pipe is unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("provider stderr pipe is unavailable")?;
    let (events, receiver) = mpsc::channel();
    let cancelled = Arc::new(AtomicBool::new(false));
    let output_line_count = Arc::new(AtomicUsize::new(0));
    let output_byte_count = Arc::new(AtomicUsize::new(0));
    let output_limit_exceeded = Arc::new(AtomicBool::new(false));
    // Once either pipe rejects output, no later model line may cross the internal event stream.
    let output_stopped = Arc::new(AtomicBool::new(false));
    let child = Arc::new(Mutex::new(Some(child)));

    let monitor_output_byte_count = Arc::clone(&output_byte_count);
    let monitor_output_stopped = Arc::clone(&output_stopped);
    let stdout_reader = stream_child_output(
        stdout,
        run_id.clone(),
        events.clone(),
        false,
        Arc::clone(&output_line_count),
        Arc::clone(&output_byte_count),
        max_output_lines,
        max_output_bytes,
        Arc::clone(&output_limit_exceeded),
        Arc::clone(&output_stopped),
        max_line_length,
    );
    let stderr_reader = stream_child_output(
        stderr,
        run_id.clone(),
        events.clone(),
        true,
        output_line_count,
        output_byte_count,
        max_output_lines,
        max_output_bytes,
        Arc::clone(&output_limit_exceeded),
        Arc::clone(&output_stopped),
        max_line_length,
    );
    let _ = events.send(AiBrokerEvent::Started {
        run_id: run_id.clone(),
    });

    let monitor_child = Arc::clone(&child);
    let monitor_cancelled = Arc::clone(&cancelled);
    std::thread::spawn(move || {
        let started_at = Instant::now();
        let mut termination_sent_at: Option<Instant> = None;
        let mut timed_out = false;
        let mut forced_kill_sent = false;

        loop {
            // Output rejection is terminal at first observation. Clean only the owned process
            // group, emit the public failure, and return without waiting for pipe-reader
            // completion: a detached sender can otherwise hold queue admission forever.
            if output_limit_exceeded.load(Ordering::SeqCst)
                || monitor_output_byte_count.load(Ordering::SeqCst) > max_output_bytes
            {
                monitor_output_stopped.store(true, Ordering::SeqCst);
                output_limit_exceeded.store(true, Ordering::SeqCst);
                // The safe-profile terminalizer owns TERM/KILL plus the independent group-
                // absence observation. Publish this bounded internal terminal now so a retained
                // pipe sender cannot hold the public queue; it retains marker/liveness evidence
                // if that later observation cannot prove the owned group is gone.
                let _ = events.send(AiBrokerEvent::OutputLimitExceeded {
                    run_id: run_id.clone(),
                });
                return;
            }
            let status = monitor_child.lock().ok().and_then(|mut child| {
                child
                    .as_mut()
                    .and_then(|child| child.try_wait().ok().flatten())
            });
            if let Some(status) = status {
                // A provider parent can exit while a nested helper remains alive and keep its
                // stdout/stderr pipes open. Clean the group first, then drain both pipes before
                // terminal classification so no JSONL line races the terminal event.
                let cleanup_succeeded = cleanup_process_group(process_group).is_ok();
                // A process that detached from the group can retain either inherited pipe. Do
                // not join reader threads here: terminal completion has a hard drain deadline.
                let drain_deadline = Instant::now() + BROKER_OUTPUT_DRAIN_TIMEOUT;
                let stdout_drained = stdout_reader
                    .completed
                    .recv_timeout(drain_deadline.saturating_duration_since(Instant::now()))
                    .is_ok();
                let stderr_drained = stderr_reader
                    .completed
                    .recv_timeout(drain_deadline.saturating_duration_since(Instant::now()))
                    .is_ok();
                if !stdout_drained || !stderr_drained {
                    output_limit_exceeded.store(true, Ordering::SeqCst);
                }
                let event = if output_limit_exceeded.load(Ordering::SeqCst) {
                    AiBrokerEvent::OutputLimitExceeded {
                        run_id: run_id.clone(),
                    }
                } else if monitor_cancelled.load(Ordering::SeqCst) {
                    AiBrokerEvent::Cancelled {
                        run_id: run_id.clone(),
                    }
                } else if timed_out {
                    AiBrokerEvent::TimedOut {
                        run_id: run_id.clone(),
                    }
                } else {
                    AiBrokerEvent::Exited {
                        run_id: run_id.clone(),
                        success: status.success() && cleanup_succeeded,
                    }
                };
                let _ = events.send(event);
                return;
            }

            let cancellation_requested = monitor_cancelled.load(Ordering::SeqCst);
            if cancellation_requested || (!timed_out && started_at.elapsed() >= timeout) {
                timed_out |= !cancellation_requested;
                if termination_sent_at.is_none() {
                    let _ = signal_process_tree(process_group, libc_signal_term());
                    termination_sent_at = Some(Instant::now());
                }
            }

            if termination_sent_at.is_some_and(|sent| sent.elapsed() >= PROCESS_TERMINATION_GRACE)
                && !forced_kill_sent
            {
                let _ = signal_process_tree(process_group, libc_signal_kill());
                forced_kill_sent = true;
            }

            std::thread::sleep(Duration::from_millis(10));
        }
    });

    Ok(AiBrokerRun {
        events: receiver,
        cancellation: AiBrokerCancellation {
            process_group,
            cancelled,
        },
        stdin: Arc::new(Mutex::new(stdin)),
    })
}

fn fixed_codex_safe_profile_command(
    broker: &CodexSafeProfileBroker,
    executable: &Path,
    request: &CodexSafeProfileStartRequest,
    paths: &CodexSafeProfileRunPaths,
) -> Command {
    let mut command = Command::new(executable);
    // The empty app-owned working directory plus `--ignore-user-config` and `--ignore-rules`
    // leaves no repository/global rule, skill, or custom-agent declaration for Codex to load;
    // `features.multi_agent=false` also prevents any nested-agent delegation.
    command
        .args(["--ask-for-approval", "never"])
        .arg("exec")
        .arg("--ephemeral")
        .arg("--ignore-user-config")
        .arg("--ignore-rules")
        .args(["--sandbox", "read-only"])
        .arg("--json")
        .arg("--output-schema")
        .arg(&paths.schema)
        .arg("--skip-git-repo-check")
        .args(["-c", "history.persistence=\"none\""])
        .args(["-c", &format!("log_dir={}", toml_string(&paths.logs))])
        .args(["-c", &format!("sqlite_home={}", toml_string(&paths.state))])
        .args(["-c", "features.hooks=false"])
        .args(["-c", "features.multi_agent=false"])
        .args(["-c", "features.shell_tool=false"])
        .args(["-c", "web_search=\"disabled\""])
        .args(["-c", "mcp_servers={}"])
        .args(["-c", "plugins={}"])
        .args(["-c", "check_for_update_on_startup=false"]);
    if let Some(model) = &request.model {
        command.args(["--model", model]);
    }
    command
        .arg("-")
        .current_dir(&paths.root)
        .env_clear()
        .env("PATH", &broker.adopted_login_shell_path);
    for name in ["HOME", "TMPDIR", "LANG", "LC_ALL"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command.env("NO_COLOR", "1");
    command
}

fn parse_codex_terminal_output(
    operation: CodexSafeProfileOperation,
    line: &str,
) -> Result<Option<serde_json::Value>, String> {
    let event: CodexJsonlEvent = serde_json::from_str(line)
        .map_err(|_| "Codex emitted malformed JSONL output".to_string())?;
    match event.kind.as_str() {
        "thread.started" | "turn.started" | "item.started" | "item.updated" | "turn.completed" => {
            Ok(None)
        }
        "item.completed" => {
            let item = event
                .item
                .ok_or("Codex completed an item without its bounded item payload")?;
            if item.kind != "agent_message" {
                return Ok(None);
            }
            let text = item
                .text
                .ok_or("Codex completed an agent message without text")?;
            if text.len() > CODEX_SAFE_PROFILE_MAX_TERMINAL_BYTES {
                return Err("Codex terminal output exceeded the safe-profile byte limit".into());
            }
            let envelope: CodexTerminalEnvelope = serde_json::from_str(&text).map_err(|_| {
                "Codex terminal output did not match the app-owned output schema".to_string()
            })?;
            validate_codex_terminal_result(operation, &envelope.result)?;
            let mut normalized_result = envelope.result;
            normalize_codex_terminal_result(operation, &mut normalized_result);
            Ok(Some(normalized_result))
        }
        "error" => Err("Codex emitted an error JSONL event".into()),
        _ => Err("Codex emitted an unsupported JSONL event".into()),
    }
}

fn persist_codex_safe_profile_terminal_evidence(
    paths: &CodexSafeProfileRunPaths,
    run_id: &str,
    provenance: &CodexSafeProfileObservedProvenance,
    reach: CodexSafeProfileAdmissionReach,
) {
    let _ = persist_codex_safe_profile_admission(
        paths,
        run_id,
        CodexSafeProfileAdmissionState::Terminal,
        provenance,
    );
    let _ = persist_codex_safe_profile_terminal_recovery(paths, run_id, provenance, reach);
}

// Every terminal path records the terminal transition first, then uses the same broker-owned
// TERM/KILL and process-group absence proof before deleting any marker-owned state. A public
// terminal event must not wait for a retained pipe sender, but inability to observe group absence
// is never treated as cleanup success or safe interruption.
fn terminalize_codex_safe_profile_run(
    paths: &CodexSafeProfileRunPaths,
    run_id: &str,
    provenance: &CodexSafeProfileObservedProvenance,
    reach: CodexSafeProfileAdmissionReach,
    process_group: i32,
) {
    persist_codex_safe_profile_terminal_evidence(paths, run_id, provenance, reach);

    if process_group <= 0 {
        return;
    }
    let _ = cleanup_process_group(process_group);
    if matches!(process_group_exists(process_group), Ok(false)) {
        cleanup_codex_safe_profile_paths(paths);
    }
}

fn stream_codex_safe_profile_output(
    run_id: String,
    operation: CodexSafeProfileOperation,
    broker_run: AiBrokerRun,
    paths: CodexSafeProfileRunPaths,
    started_at: Instant,
    provenance: CodexSafeProfileObservedProvenance,
) -> CodexSafeProfileRun {
    // A stream exists only once durable active admission committed and the webview received the
    // admitted event, so every terminal below retains admitted recovery evidence.
    let cancellation = broker_run.cancellation();
    let cancellation_for_stream = cancellation.clone();
    let (events, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut terminal_result = None;
        let mut invalid_output = false;
        for event in broker_run.events {
            match event {
                AiBrokerEvent::Started { .. } => {
                    let _ = events.send(CodexSafeProfileEvent::Started {
                        run_id: run_id.clone(),
                        provenance: Some(provenance.clone()),
                    });
                }
                AiBrokerEvent::Stdout { line, .. } => {
                    match parse_codex_terminal_output(operation, &line) {
                        Ok(Some(result)) if terminal_result.is_none() => {
                            terminal_result = Some(result)
                        }
                        Ok(Some(_)) | Err(_) => {
                            invalid_output = true;
                            let _ = cancellation_for_stream.cancel();
                        }
                        Ok(None) => {
                            let _ = events.send(CodexSafeProfileEvent::Progress {
                                run_id: run_id.clone(),
                            });
                        }
                    }
                }
                // stderr can include provider internals, paths, or account data. It is drained to
                // avoid a child-process pipe deadlock but never crosses the broker boundary.
                AiBrokerEvent::Stderr { .. } => {}
                AiBrokerEvent::OutputLimitExceeded { .. } => {
                    // Publish one public terminal immediately. The common terminalizer below
                    // performs bounded group cleanup and retains evidence if absence is
                    // unresolved, so retained pipe senders cannot delay queue release.
                    persist_codex_safe_profile_terminal_evidence(
                        &paths,
                        &run_id,
                        &provenance,
                        CodexSafeProfileAdmissionReach::Admitted,
                    );
                    let _ = events.send(CodexSafeProfileEvent::Failed {
                        run_id: run_id.clone(),
                        code: "invalid-output".into(),
                        provenance: Some(provenance.clone()),
                    });
                    break;
                }
                AiBrokerEvent::Exited { success, .. } => {
                    let event = if !success || invalid_output {
                        CodexSafeProfileEvent::Failed {
                            run_id: run_id.clone(),
                            code: if invalid_output {
                                "invalid-output".into()
                            } else {
                                "process-failed".into()
                            },
                            provenance: Some(provenance.clone()),
                        }
                    } else if let Some(result) = terminal_result.take() {
                        CodexSafeProfileEvent::Completed {
                            run_id: run_id.clone(),
                            result,
                            usage: CodexSafeProfileUsage {
                                elapsed_ms: started_at
                                    .elapsed()
                                    .as_millis()
                                    .try_into()
                                    .unwrap_or(u64::MAX),
                                tool_event_count: 0,
                            },
                            provenance: Some(provenance.clone()),
                        }
                    } else {
                        CodexSafeProfileEvent::Failed {
                            run_id: run_id.clone(),
                            code: "invalid-output".into(),
                            provenance: Some(provenance.clone()),
                        }
                    };
                    persist_codex_safe_profile_terminal_evidence(
                        &paths,
                        &run_id,
                        &provenance,
                        CodexSafeProfileAdmissionReach::Admitted,
                    );
                    let _ = events.send(event);
                    break;
                }
                AiBrokerEvent::TimedOut { .. } => {
                    persist_codex_safe_profile_terminal_evidence(
                        &paths,
                        &run_id,
                        &provenance,
                        CodexSafeProfileAdmissionReach::Admitted,
                    );
                    let _ = events.send(CodexSafeProfileEvent::Failed {
                        run_id: run_id.clone(),
                        code: "timeout".into(),
                        provenance: Some(provenance.clone()),
                    });
                    break;
                }
                AiBrokerEvent::Cancelled { .. } => {
                    persist_codex_safe_profile_terminal_evidence(
                        &paths,
                        &run_id,
                        &provenance,
                        CodexSafeProfileAdmissionReach::Admitted,
                    );
                    let _ = events.send(CodexSafeProfileEvent::Failed {
                        run_id: run_id.clone(),
                        code: if invalid_output {
                            "invalid-output".into()
                        } else {
                            "cancelled".into()
                        },
                        provenance: Some(provenance.clone()),
                    });
                    break;
                }
            }
        }
        terminalize_codex_safe_profile_run(
            &paths,
            &run_id,
            &provenance,
            CodexSafeProfileAdmissionReach::Admitted,
            cancellation_for_stream.process_group,
        );
    });
    CodexSafeProfileRun {
        events: receiver,
        cancellation,
    }
}

fn materialize_verified_codex_executable(
    paths: &CodexSafeProfileRunPaths,
    verified_launch: &VerifiedCodexLaunch,
) -> Result<(), String> {
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&paths.executable)
        .map_err(|_| "could not create the verified Codex executable materialization")?;
    let copied_digest = copy_verified_executable_materialization(
        verified_launch.observed_executable.descriptor.as_ref(),
        &mut file,
    )?;
    if copied_digest != verified_launch.observed_executable.identity.content_digest {
        return Err("verified Codex descriptor changed before materialization".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&paths.executable, std::fs::Permissions::from_mode(0o500))
            .map_err(|_| "could not make the verified Codex materialization executable")?;
    }
    let materialized = std::fs::File::open(&paths.executable)
        .map_err(|_| "could not re-open the verified Codex materialization")?;
    if digest_open_executable(&materialized)?
        != verified_launch.observed_executable.identity.content_digest
    {
        return Err(
            "verified Codex materialization identity does not match the observed descriptor".into(),
        );
    }
    Ok(())
}

fn verify_spawn_before_prompt(
    broker_run: &AiBrokerRun,
    paths: &CodexSafeProfileRunPaths,
    verified_launch: &VerifiedCodexLaunch,
) -> Result<(), String> {
    // This confirms the just-spawned PID has a kernel process-birth identity before stdin leaves
    // the broker. S89 tightens the Darwin representation; this launch ordering is already strict.
    process_start_identity(broker_run.cancellation.process_group)
        .ok_or("could not verify the spawned Codex process identity before prompt delivery")?;
    let materialized = std::fs::File::open(&paths.executable).map_err(|_| {
        "could not inspect the materialized Codex executable before prompt delivery"
    })?;
    if digest_open_executable(&materialized)?
        != verified_launch.observed_executable.identity.content_digest
    {
        return Err("materialized Codex executable changed before prompt delivery".into());
    }
    Ok(())
}

fn start_codex_safe_profile_with_executable(
    broker: &CodexSafeProfileBroker,
    executable: &Path,
    app_owned_root: &Path,
    request: CodexSafeProfileStartRequest,
    timeout: Duration,
    provenance: CodexSafeProfileObservedProvenance,
) -> Result<CodexSafeProfileRun, String> {
    // Test-only/direct callers still receive descriptor-derived materialization rather than a
    // path launch. Production reaches this through a broker-issued verified receipt below.
    let file = std::fs::File::open(executable)
        .map_err(|_| "could not open the fixed Codex executable descriptor")?;
    let metadata = file
        .metadata()
        .map_err(|_| "could not inspect the fixed Codex executable descriptor")?;
    let identity = codex_executable_identity(&file, &metadata)?;
    start_codex_safe_profile_with_verified_launch(
        broker,
        app_owned_root,
        request,
        timeout,
        VerifiedCodexLaunch {
            observed_executable: ObservedCodexExecutable {
                source_path: executable.to_path_buf(),
                identity,
                descriptor: Arc::new(file),
            },
            provenance,
        },
    )
}

fn start_codex_safe_profile_with_verified_launch(
    broker: &CodexSafeProfileBroker,
    app_owned_root: &Path,
    request: CodexSafeProfileStartRequest,
    timeout: Duration,
    verified_launch: VerifiedCodexLaunch,
) -> Result<CodexSafeProfileRun, String> {
    let paths = CodexSafeProfileRunPaths::create(app_owned_root, &request)?;
    // This private direct helper is test-only coverage for fixed argv/schema construction. The
    // public receipt path below always revalidates every pre-disclosure boundary.
    let cancellation_latch = Arc::new(AtomicBool::new(false));
    start_codex_safe_profile_from_paths(
        broker,
        request,
        timeout,
        verified_launch,
        paths,
        false,
        &cancellation_latch,
    )
}

fn start_codex_safe_profile_from_paths(
    broker: &CodexSafeProfileBroker,
    request: CodexSafeProfileStartRequest,
    timeout: Duration,
    verified_launch: VerifiedCodexLaunch,
    paths: CodexSafeProfileRunPaths,
    revalidate_receipt: bool,
    cancellation_latch: &Arc<AtomicBool>,
) -> Result<CodexSafeProfileRun, String> {
    request.validate()?;
    let ensure_not_cancelled = || {
        (!cancellation_latch.load(Ordering::SeqCst))
            .then_some(())
            .ok_or_else(|| {
                "Codex safe-profile request was cancelled before stdin delivery".to_string()
            })
    };
    ensure_not_cancelled()?;
    // A marked run root exists before any child can exist. Record the cancellable preparation
    // transition without retaining its prompt, then record the immediate spawn boundary.
    if let Err(error) = persist_codex_safe_profile_admission(
        &paths,
        &request.run_id,
        CodexSafeProfileAdmissionState::Preparing,
        &verified_launch.provenance,
    ) {
        cleanup_codex_safe_profile_paths(&paths);
        return Err(error);
    }
    ensure_not_cancelled()?;
    if let Err(error) = std::fs::write(
        &paths.schema,
        codex_safe_profile_output_schema(request.operation),
    ) {
        cleanup_codex_safe_profile_paths(&paths);
        return Err(format!(
            "could not write Codex safe-profile output schema: {error}"
        ));
    }
    // Revalidate the exact opaque receipt immediately before each irreversible boundary. The
    // descriptor-derived materialization never follows a webview path, so a replacement fails
    // before its bytes can be spawned or receive stdin.
    ensure_not_cancelled()?;
    let verified_launch = if revalidate_receipt {
        broker.revalidate_verified_launch(&verified_launch)?
    } else {
        verified_launch
    };
    ensure_not_cancelled()?;
    if let Err(error) = materialize_verified_codex_executable(&paths, &verified_launch) {
        cleanup_codex_safe_profile_paths(&paths);
        return Err(error);
    }
    let verified_launch = if revalidate_receipt {
        broker.revalidate_verified_launch(&verified_launch)?
    } else {
        verified_launch
    };
    ensure_not_cancelled()?;
    let materialized = std::fs::File::open(&paths.executable)
        .map_err(|_| "could not inspect the materialized Codex executable before spawn")?;
    if digest_open_executable(&materialized)?
        != verified_launch.observed_executable.identity.content_digest
    {
        cleanup_codex_safe_profile_paths(&paths);
        return Err("materialized Codex executable changed before spawn".into());
    }
    ensure_not_cancelled()?;
    let command = fixed_codex_safe_profile_command(broker, &paths.executable, &request, &paths);
    if let Err(error) = persist_codex_safe_profile_admission(
        &paths,
        &request.run_id,
        CodexSafeProfileAdmissionState::Preparing,
        &verified_launch.provenance,
    ) {
        cleanup_codex_safe_profile_paths(&paths);
        return Err(error);
    }
    ensure_not_cancelled()?;
    let started_at = Instant::now();
    // The child receives a pipe but no bytes until both post-spawn checks below have succeeded.
    let broker_run = match start_broker_process_with_deferred_input(
        request.run_id.clone(),
        command,
        timeout,
        CODEX_SAFE_PROFILE_MAX_JSONL_LINES,
        CODEX_SAFE_PROFILE_MAX_TERMINAL_BYTES,
        CODEX_SAFE_PROFILE_MAX_JSONL_LINE_BYTES,
    ) {
        Ok(run) => run,
        Err(error) => {
            cleanup_codex_safe_profile_paths(&paths);
            return Err(error);
        }
    };
    if cancellation_latch.load(Ordering::SeqCst) {
        let _ = broker_run.cancel();
        return Err("Codex safe-profile request was cancelled after spawn verification".into());
    }
    let verified_launch = if revalidate_receipt {
        match broker.revalidate_verified_launch(&verified_launch) {
            Ok(verified_launch) => verified_launch,
            Err(error) => {
                let _ = broker_run.cancel();
                cleanup_codex_safe_profile_paths(&paths);
                return Err(error);
            }
        }
    } else {
        verified_launch
    };
    if cancellation_latch.load(Ordering::SeqCst) {
        let _ = broker_run.cancel();
        return Err("Codex safe-profile request was cancelled before spawn verification".into());
    }
    if let Err(error) = verify_spawn_before_prompt(&broker_run, &paths, &verified_launch) {
        let _ = broker_run.cancel();
        cleanup_codex_safe_profile_paths(&paths);
        return Err(error);
    }
    // Persist the marker-bound PID/start identity before this spawned child is exposed as an
    // active provider. A crash in the following registration path can then be recovered without
    // trusting PID reuse or deleting a possibly live process's state.
    if cancellation_latch.load(Ordering::SeqCst) {
        let _ = broker_run.cancel();
        return Err("Codex safe-profile request was cancelled before liveness persistence".into());
    }
    let process_group = broker_run.cancellation.process_group;
    let durable_admission_failure = |error: String| {
        // No stream thread exists at this boundary. Close the still-undisclosed prompt and wait
        // for the owned group before exposing the single pre-admission terminal to the webview.
        broker_run.close_stdin();
        broker_run
            .cancellation
            .cancelled
            .store(true, Ordering::SeqCst);
        terminalize_codex_safe_profile_run(
            &paths,
            &request.run_id,
            &verified_launch.provenance,
            CodexSafeProfileAdmissionReach::PreAdmission,
            process_group,
        );
        format!("Codex safe-profile admission unavailable: {error}")
    };
    if let Err(error) =
        persist_codex_safe_profile_liveness(&paths, &request.run_id, process_group, process_group)
    {
        return Err(durable_admission_failure(error));
    }
    if let Err(error) =
        verify_codex_safe_profile_liveness(&paths, &request.run_id, process_group, process_group)
    {
        return Err(durable_admission_failure(error));
    }
    if cancellation_latch.load(Ordering::SeqCst) {
        broker_run.close_stdin();
        let _ = broker_run.cancel();
        return Err("Codex safe-profile request was cancelled before stdin delivery".into());
    }
    // Durable marker-owned admission and liveness records are both committed and verified before
    // this child can become active or receive stdin. This happens before stream creation, so a
    // terminal/output path cannot race a failed evidence write and delete its recovery state.
    if let Err(error) = persist_and_verify_codex_safe_profile_admission(
        &paths,
        &request.run_id,
        CodexSafeProfileAdmissionState::Active,
        &verified_launch.provenance,
    ) {
        return Err(durable_admission_failure(error));
    }
    if cancellation_latch.load(Ordering::SeqCst) {
        broker_run.close_stdin();
        let _ = broker_run.cancel();
        return Err("Codex safe-profile request was cancelled before stdin delivery".into());
    }
    if let Err(error) = broker_run.disclose_stdin(request.prompt.into_bytes()) {
        broker_run.close_stdin();
        let _ = broker_run.cancel();
        cleanup_codex_safe_profile_paths(&paths);
        return Err(error);
    }
    Ok(stream_codex_safe_profile_output(
        request.run_id,
        request.operation,
        broker_run,
        paths,
        started_at,
        verified_launch.provenance,
    ))
}

fn start_codex_safe_profile(
    broker: &CodexSafeProfileBroker,
    request: CodexSafeProfileStartRequest,
    paths: CodexSafeProfileRunPaths,
    expected_launch: VerifiedCodexLaunch,
    cancellation_latch: &Arc<AtomicBool>,
) -> Result<CodexSafeProfileRun, String> {
    if cancellation_latch.load(Ordering::SeqCst) {
        return Err("Codex safe-profile request was cancelled before receipt revalidation".into());
    }
    let revalidated_launch = broker.revalidate_verified_launch(&expected_launch)?;
    start_codex_safe_profile_from_paths(
        broker,
        request,
        CODEX_SAFE_PROFILE_TIMEOUT,
        revalidated_launch,
        paths,
        true,
        cancellation_latch,
    )
}

fn codex_safe_profile_launch_failure_code(error: &str) -> &'static str {
    if error.starts_with("Codex safe-profile admission unavailable:") {
        "admission-unavailable"
    } else {
        "process-failed"
    }
}

// Generic over the Tauri runtime so the production launcher itself can be driven on a mock app
// instead of being reproduced in a test harness. The real app monomorphises this to its own runtime.
fn launch_admitted_codex_safe_profile_run<R: Runtime>(
    app: tauri::AppHandle<R>,
    broker: CodexSafeProfileBroker,
    active_runs: &CodexSafeProfileActiveRuns,
    request: CodexSafeProfileStartRequest,
    paths: CodexSafeProfileRunPaths,
    verified_launch: VerifiedCodexLaunch,
) {
    let run_id = request.run_id.clone();
    let launch_provenance = verified_launch.provenance.clone();
    // This transition is the sole dequeue-to-launch handoff. Cancellation can latch this shared
    // state before a process exists; a latched preparation never reaches spawn or prompt input.
    let preparing = match active_runs.begin_preparing(&run_id) {
        Ok(preparing) => preparing,
        Err(_) => return,
    };
    if preparing.load(Ordering::SeqCst) {
        if active_runs.claim_terminal_publication(&run_id) {
            let _ = app.emit(
                "codex-safe-profile-event",
                CodexSafeProfileEvent::Failed {
                    run_id: run_id.clone(),
                    code: "cancelled".into(),
                    provenance: Some(launch_provenance),
                },
            );
        }
        if let Ok(Some(next)) = active_runs.release(&run_id) {
            launch_admitted_codex_safe_profile_run(
                app,
                broker,
                active_runs,
                next.request,
                next.paths,
                next.verified_launch,
            );
        }
        return;
    }
    let run = match start_codex_safe_profile(&broker, request, paths, verified_launch, &preparing) {
        Ok(run) => run,
        Err(error) => {
            let code = codex_safe_profile_launch_failure_code(&error);
            // The failed durable transition owns cleanup synchronously before it returns here.
            // Atomically terminalize/release its preparing control before exposing the one public
            // failure, so neither an event listener nor FIFO release can observe half-admission.
            let next = active_runs
                .fail_preparing_and_release(&run_id)
                .ok()
                .flatten();
            if active_runs.claim_terminal_publication(&run_id) {
                let _ = app.emit(
                    "codex-safe-profile-event",
                    CodexSafeProfileEvent::Failed {
                        run_id: run_id.clone(),
                        code: code.into(),
                        provenance: Some(launch_provenance),
                    },
                );
            }
            if let Some(next) = next {
                launch_admitted_codex_safe_profile_run(
                    app,
                    broker,
                    active_runs,
                    next.request,
                    next.paths,
                    next.verified_launch,
                );
            }
            return;
        }
    };
    // Cancellation may race preparation after the pre-spawn check. It is still checked before
    // active registration and prompt disclosure; cleanup is broker-owned and no stale admission
    // can survive into the active map.
    if preparing.load(Ordering::SeqCst)
        || active_runs
            .register_active(&run_id, run.cancellation.clone(), &preparing)
            .is_err()
    {
        // Exit can race an admitted launch between spawning the child and registering its
        // cancellation handle. The registry's shutdown flag rejects that late registration, so
        // this branch must use bounded TERM/KILL cleanup rather than leaving a TERM-only child.
        run.cancellation.cancelled.store(true, Ordering::SeqCst);
        let _ = cleanup_process_group(run.cancellation.process_group);
        if let Ok(Some(next)) = active_runs.release(&run_id) {
            launch_admitted_codex_safe_profile_run(
                app,
                broker,
                active_runs,
                next.request,
                next.paths,
                next.verified_launch,
            );
        }
        return;
    }
    let _ = app.emit(
        "codex-safe-profile-event",
        CodexSafeProfileEvent::Admitted {
            run_id: run_id.clone(),
            provenance: launch_provenance,
        },
    );
    let app_for_events = app.clone();
    let broker_for_next = broker.clone();
    std::thread::spawn(move || {
        for event in run.events {
            let terminal = matches!(
                event,
                CodexSafeProfileEvent::Completed { .. } | CodexSafeProfileEvent::Failed { .. }
            );
            let _ = app_for_events.emit("codex-safe-profile-event", event);
            if terminal {
                break;
            }
        }
        if let Some(active_runs) = app_for_events.try_state::<CodexSafeProfileActiveRuns>() {
            if let Ok(Some(next)) = active_runs.release(&run_id) {
                launch_admitted_codex_safe_profile_run(
                    app_for_events.clone(),
                    broker_for_next,
                    &active_runs,
                    next.request,
                    next.paths,
                    next.verified_launch,
                );
            }
        }
    });
}

#[tauri::command]
pub fn codex_safe_profile_start(
    app: tauri::AppHandle,
    broker: tauri::State<'_, CodexSafeProfileBroker>,
    active_runs: tauri::State<'_, CodexSafeProfileActiveRuns>,
    request: CodexSafeProfileStartRequest,
) -> Result<CodexSafeProfileStartResponse, String> {
    request.validate()?;
    // An opaque receipt is the entire availability gate. It is issued only for the exact
    // descriptor/version/help/profile contract, and a missing or stale receipt cannot reserve
    // queue state, create a root, or start a child.
    let verified_launch = broker.verified_receipt(&request.provenance_receipt_id)?;
    let app_owned_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("could not resolve the app-owned AI data directory: {error}"))?;
    let run_id = request.run_id.clone();
    // Reserve only a marker-owned, prompt-free root before queueing so a crash has durable
    // queued/preparing evidence. The fixed launcher reuses this exact root after admission.
    let paths = CodexSafeProfileRunPaths::create(&app_owned_root, &request)?;
    if let Err(error) = persist_codex_safe_profile_admission(
        &paths,
        &run_id,
        CodexSafeProfileAdmissionState::Queued,
        &verified_launch.provenance,
    ) {
        cleanup_codex_safe_profile_paths(&paths);
        return Err(error);
    }
    let queue_state =
        match active_runs.enqueue(request.clone(), paths.clone(), verified_launch.clone()) {
            Ok(queue_state) => queue_state,
            Err(error) => {
                cleanup_codex_safe_profile_paths(&paths);
                return Err(error);
            }
        };
    match queue_state {
        AiBrokerQueueState::Started => launch_admitted_codex_safe_profile_run(
            app,
            broker.inner().clone(),
            &active_runs,
            request,
            paths,
            verified_launch,
        ),
        AiBrokerQueueState::Queued => {
            let _ = app.emit(
                "codex-safe-profile-event",
                CodexSafeProfileEvent::Queued {
                    run_id: run_id.clone(),
                },
            );
        }
    }
    Ok(CodexSafeProfileStartResponse { run_id })
}

// Generic over the Tauri runtime for the same reason as the launcher above.
#[tauri::command]
pub fn codex_safe_profile_cancel<R: Runtime>(
    app: tauri::AppHandle<R>,
    active_runs: tauri::State<'_, CodexSafeProfileActiveRuns>,
    request: CodexSafeProfileCancelRequest,
) -> Result<(), String> {
    if request.run_id.is_empty() || request.run_id.len() > 128 {
        return Err("Codex safe-profile run IDs must be bounded opaque identifiers.".into());
    }
    if active_runs.cancel(&request.run_id)? {
        let _ = app.emit(
            "codex-safe-profile-event",
            CodexSafeProfileEvent::Failed {
                run_id: request.run_id,
                code: "cancelled".into(),
                provenance: None,
            },
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // A panicking test never reaches its explicit cleanup, so every temp app-owned root is owned by
    // this guard instead. `Drop` runs during unwinding, which keeps the machine's temp directory
    // from filling up with abandoned run roots and materialized executables across many runs.
    struct TestScratchRoot {
        path: PathBuf,
    }

    impl TestScratchRoot {
        fn new(name: &str) -> Self {
            Self {
                path: std::env::temp_dir().join(format!(
                    "{name}-{}-{}",
                    std::process::id(),
                    Instant::now().elapsed().as_nanos()
                )),
            }
        }
    }

    // Deref covers `&scratch` where a `&Path` is expected; `AsRef` covers the generic
    // `AsRef<Path>` filesystem calls, which do not get deref coercion.
    impl AsRef<Path> for TestScratchRoot {
        fn as_ref(&self) -> &Path {
            &self.path
        }
    }

    impl std::ops::Deref for TestScratchRoot {
        type Target = Path;

        fn deref(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestScratchRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn test_queued_paths(run_id: &str) -> CodexSafeProfileRunPaths {
        let root = PathBuf::from(format!("/broker-owned-test/{run_id}"));
        CodexSafeProfileRunPaths {
            config: root.join("config.toml"),
            state: root.join("state"),
            logs: root.join("logs"),
            schema: root.join("output-schema.json"),
            executable: root.join("codex-verified"),
            root,
        }
    }

    fn test_verified_launch() -> VerifiedCodexLaunch {
        VerifiedCodexLaunch {
            observed_executable: ObservedCodexExecutable {
                source_path: PathBuf::from("/broker-owned-test-codex"),
                identity: CodexExecutableIdentity {
                    device: 0,
                    inode: 0,
                    birth_seconds: 0,
                    birth_nanoseconds: 0,
                    content_digest: "2".repeat(64),
                },
                descriptor: Arc::new(
                    std::fs::File::open(
                        std::env::current_exe().expect("locate a broker-owned test descriptor"),
                    )
                    .expect("open broker-owned test descriptor"),
                ),
            },
            provenance: CodexSafeProfileObservedProvenance {
                executable_identity_digest: "0".repeat(64),
                cli_version: "0.153.4".into(),
                help_digest: "1".repeat(64),
                safe_profile_revision: CODEX_SAFE_PROFILE_REVISION.into(),
                provenance_fingerprint: "3".repeat(64),
            },
        }
    }

    #[test]
    fn webview_capabilities_do_not_allow_ai_or_arbitrary_programs() {
        // Arrange
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("desktop capability manifest is valid JSON");
        let permissions = capability["permissions"]
            .as_array()
            .expect("desktop capability manifest has permissions");

        // Act
        let mut webview_shell_commands: Vec<&str> = permissions
            .iter()
            .filter_map(|permission| permission.as_object())
            .filter(|permission| {
                permission
                    .get("identifier")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|identifier| identifier.starts_with("shell:"))
            })
            .flat_map(|permission| {
                permission
                    .get("allow")
                    .and_then(serde_json::Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|entry| entry.get("cmd").and_then(serde_json::Value::as_str))
            })
            .collect();
        webview_shell_commands.sort_unstable();
        webview_shell_commands.dedup();

        // Assert
        assert_eq!(webview_shell_commands, vec!["gh", "git"]);
        assert!(
            !permissions
                .iter()
                .any(|permission| permission.to_string().contains("claude")),
            "the webview must not receive a Claude shell capability"
        );
        assert!(
            !permissions
                .iter()
                .any(|permission| permission.to_string().contains("codex")),
            "the webview must not receive a Codex shell capability"
        );
    }

    #[test]
    fn fixed_full_review_and_chat_schemas_reject_incomplete_unknown_and_mismatched_fixture_fields()
    {
        // Arrange
        let review_result = serde_json::json!({
            "summary": "Fixed full review contract.",
            "findings": [],
            "requirementCoverage": null,
            "reportedModel": null,
        });
        let chat_result = serde_json::json!({
            "message": "Fixed full chat contract.",
            "findingCandidate": null,
            "reportedModel": null,
        });
        let jsonl = |result: serde_json::Value| {
            // Build both JSON layers with serde_json: `text` itself is a JSON terminal envelope,
            // so hand-escaped interpolation can accidentally leave its closing braces outside
            // the string and test malformed JSONL rather than the fixed terminal contract.
            let terminal_envelope = serde_json::to_string(&serde_json::json!({ "result": result }))
                .expect("serialize fixed terminal envelope");
            serde_json::to_string(&serde_json::json!({
                "type": "item.completed",
                "item": { "type": "agent_message", "text": terminal_envelope },
            }))
            .expect("serialize fixed JSONL fixture")
        };
        let incomplete_review = jsonl(serde_json::json!({
            "summary": "Missing model provenance.",
            "findings": [],
            "requirementCoverage": null,
        }));
        let unknown_review = jsonl(serde_json::json!({
            "summary": "Model-controlled usage is forbidden.",
            "findings": [],
            "requirementCoverage": null,
            "reportedModel": null,
            "usage": {},
        }));
        let malformed_chat = jsonl(serde_json::json!({
            "message": "Incomplete candidate.",
            "findingCandidate": { "id": "candidate-only" },
            "reportedModel": null,
        }));
        let non_mismatch_finding = serde_json::json!({
            "id": "finding-1",
            "title": "A complete non-mismatch finding.",
            "severity": "low",
            "confidence": "high",
            "category": "correctness",
            "path": null,
            "side": null,
            "startLine": null,
            "endLine": null,
            "evidence": "The empty context has no inline anchor.",
            "impact": "The contract must retain its complete shape.",
            "suggestedFix": null,
            "source": "code-review",
        });
        let missing_criterion_review = jsonl(serde_json::json!({
            "summary": "Missing required transport field.",
            "findings": [non_mismatch_finding],
            "requirementCoverage": null,
            "reportedModel": null,
        }));
        let nullable_review = jsonl(serde_json::json!({
            "summary": "Required null transport field.",
            "findings": [{
                "id": "finding-2",
                "title": "A complete non-mismatch finding.",
                "severity": "low",
                "confidence": "high",
                "category": "correctness",
                "path": null,
                "side": null,
                "startLine": null,
                "endLine": null,
                "evidence": "The empty context has no inline anchor.",
                "impact": "The contract must retain its complete shape.",
                "suggestedFix": null,
                "source": "code-review",
                "requirementCriterion": null,
            }],
            "requirementCoverage": null,
            "reportedModel": null,
        }));
        let nullable_chat = jsonl(serde_json::json!({
            "message": "Required null transport field.",
            "findingCandidate": {
                "id": "finding-3",
                "title": "A complete non-mismatch finding.",
                "severity": "low",
                "confidence": "high",
                "category": "correctness",
                "path": null,
                "side": null,
                "startLine": null,
                "endLine": null,
                "evidence": "The empty context has no inline anchor.",
                "impact": "The contract must retain its complete shape.",
                "suggestedFix": null,
                "source": "chat",
                "requirementCriterion": null,
            },
            "reportedModel": null,
        }));
        let mismatch_with_null_criterion = jsonl(serde_json::json!({
            "summary": "Mismatch requires an object criterion.",
            "findings": [{
                "id": "finding-4",
                "title": "A mismatch cannot use null.",
                "severity": "low",
                "confidence": "high",
                "category": "requirements",
                "path": null,
                "side": null,
                "startLine": null,
                "endLine": null,
                "evidence": "The immutable requirement evidence conflicts.",
                "impact": "A criterion reference is required.",
                "suggestedFix": null,
                "source": "requirement-mismatch",
                "requirementCriterion": null,
            }],
            "requirementCoverage": null,
            "reportedModel": null,
        }));

        // Act
        let review_schema: serde_json::Value = serde_json::from_str(
            codex_safe_profile_output_schema(CodexSafeProfileOperation::Review),
        )
        .expect("the embedded review schema is valid JSON");
        let chat_schema: serde_json::Value = serde_json::from_str(
            codex_safe_profile_output_schema(CodexSafeProfileOperation::Chat),
        )
        .expect("the embedded chat schema is valid JSON");
        let parsed_review =
            parse_codex_terminal_output(CodexSafeProfileOperation::Review, &jsonl(review_result));
        let parsed_chat =
            parse_codex_terminal_output(CodexSafeProfileOperation::Chat, &jsonl(chat_result));
        let incomplete =
            parse_codex_terminal_output(CodexSafeProfileOperation::Review, &incomplete_review);
        let unknown =
            parse_codex_terminal_output(CodexSafeProfileOperation::Review, &unknown_review);
        let malformed =
            parse_codex_terminal_output(CodexSafeProfileOperation::Chat, &malformed_chat);
        let missing_criterion = parse_codex_terminal_output(
            CodexSafeProfileOperation::Review,
            &missing_criterion_review,
        );
        let normalized_nullable_review =
            parse_codex_terminal_output(CodexSafeProfileOperation::Review, &nullable_review);
        let normalized_nullable_chat =
            parse_codex_terminal_output(CodexSafeProfileOperation::Chat, &nullable_chat);
        let mismatch_with_null = parse_codex_terminal_output(
            CodexSafeProfileOperation::Review,
            &mismatch_with_null_criterion,
        );
        let mismatched = parse_codex_terminal_output(
            CodexSafeProfileOperation::Review,
            &jsonl(serde_json::json!({
                "message": "A chat result cannot satisfy the review schema.",
                "findingCandidate": null,
                "reportedModel": null,
            })),
        );

        // Assert
        assert_eq!(review_schema["additionalProperties"], false);
        assert_eq!(chat_schema["additionalProperties"], false);
        for schema in [&review_schema, &chat_schema] {
            let finding = &schema["$defs"]["finding"];
            assert_eq!(
                finding["required"],
                serde_json::json!([
                    "id",
                    "title",
                    "severity",
                    "confidence",
                    "category",
                    "path",
                    "side",
                    "startLine",
                    "endLine",
                    "evidence",
                    "impact",
                    "suggestedFix",
                    "source",
                    "requirementCriterion",
                ]),
                "every declared finding property is required by Codex's strict schema compiler"
            );
            assert_eq!(
                finding["properties"]["requirementCriterion"],
                serde_json::json!({
                    "anyOf": [
                        { "type": "null" },
                        { "$ref": "#/$defs/criterion" },
                    ]
                }),
                "non-mismatch findings remain representable with the required transport null"
            );
        }
        assert!(parsed_review.expect("complete review parses").is_some());
        assert!(parsed_chat.expect("complete chat parses").is_some());
        assert!(
            incomplete.is_err(),
            "incomplete terminal objects fail closed"
        );
        assert!(
            unknown.is_err(),
            "unknown model-owned coverage or usage fields fail closed"
        );
        assert!(
            malformed.is_err(),
            "incomplete nested candidates fail closed"
        );
        assert!(
            missing_criterion.is_err(),
            "the transport field is required even for non-mismatch findings"
        );
        assert_eq!(
            normalized_nullable_review
                .expect("required null review finding parses")
                .expect("agent message yields a terminal result")["findings"][0]
                .get("requirementCriterion"),
            None,
            "the required transport null does not cross into the optional shared contract"
        );
        assert_eq!(
            normalized_nullable_chat
                .expect("required null chat finding parses")
                .expect("agent message yields a terminal result")["findingCandidate"]
                .get("requirementCriterion"),
            None,
            "the required transport null does not cross into the optional shared contract"
        );
        assert!(
            mismatch_with_null.is_err(),
            "requirement-mismatch findings still require an object criterion"
        );
        assert!(
            mismatched.is_err(),
            "the closed operation cannot select another schema"
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_safe_profile_webview_cannot_select_executable_or_arguments() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-codex-safe-profile-request");
        std::fs::create_dir_all(&scratch).expect("create Codex safe-profile scratch directory");
        let fabricated_executable = scratch.join("codex");
        let fabricated_marker = scratch.join("fabricated-ran");
        std::fs::write(
            &fabricated_executable,
            format!("#!/bin/sh\ntouch '{}'\n", fabricated_marker.display()),
        )
        .expect("write fabricated Codex executable");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            &fabricated_executable,
            std::fs::Permissions::from_mode(0o700),
        )
        .expect("make fabricated Codex executable runnable");
        let malicious_request = serde_json::json!({
            "runId": "review-1",
            "prKey": "acme/web#42",
            "prompt": "review this bounded context",
            "model": "gpt-5",
            "executable": fabricated_executable,
            "arguments": ["--danger-full-access"]
        });
        let captured_broker = CodexSafeProfileBroker::with_adopted_login_shell_path(
            OsString::from("/broker-captured-path-only"),
        );
        let command_surface = include_str!("lib.rs");

        // Act
        let parsed_malicious_request =
            serde_json::from_value::<CodexSafeProfileStartRequest>(malicious_request);
        let resolved_executable = captured_broker.resolve_executable();
        let legacy_commands = ["ai_discover_executable", "ai_probe_capabilities"]
            .into_iter()
            .filter(|command| command_surface.contains(command))
            .collect::<Vec<_>>();

        // Assert
        assert!(
            parsed_malicious_request.is_err(),
            "the typed request rejects webview executable and argument fields"
        );
        assert!(
            resolved_executable.is_err(),
            "a fabricated Codex file outside the broker-captured login-shell PATH cannot be selected"
        );
        assert!(
            !fabricated_marker.exists(),
            "validating a request and resolving the fixed broker identity never runs a fabricated executable"
        );
        assert!(
            legacy_commands.is_empty(),
            "legacy executable discovery and generic capability-probe commands remain absent"
        );
        assert!(
            command_surface.contains("codex_safe_profile_capability"),
            "the webview gets only the no-argument typed safe-profile capability command"
        );

        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn codex_safe_profile_generates_only_app_owned_config_and_state_paths() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-codex-safe-profile-paths");
        let request = CodexSafeProfileStartRequest {
            run_id: "review-1".into(),
            pr_key: "acme/web#42".into(),
            operation: CodexSafeProfileOperation::Review,
            prompt: "review this bounded context".into(),
            model: Some("gpt-5".into()),
            provenance_receipt_id: "test-receipt".into(),
        };

        // Act
        let paths = CodexSafeProfileRunPaths::create(&scratch, &request)
            .expect("create broker-owned Codex safe-profile paths");
        let config = std::fs::read_to_string(&paths.config).expect("read generated safe config");

        // Assert
        assert!(paths.root.starts_with(scratch.join("codex-safe-profile")));
        assert!(paths.state.is_dir());
        assert!(paths.logs.is_dir());
        assert_eq!(paths.schema, paths.root.join("output-schema.json"));
        assert!(config.contains("history.persistence = \"none\""));
        assert!(config.contains("hooks = false"));
        assert!(config.contains("multi_agent = false"));
        assert!(config.contains("shell_tool = false"));

        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn config_write_failure_removes_only_the_owned_reserved_run_directory() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-codex-safe-profile-config-cleanup");
        let request = CodexSafeProfileStartRequest {
            run_id: "config-write-failure".into(),
            pr_key: "acme/web#42".into(),
            operation: CodexSafeProfileOperation::Review,
            prompt: "review this bounded context".into(),
            model: None,
            provenance_receipt_id: "test-receipt".into(),
        };
        let profile_root = scratch.join("codex-safe-profile");
        let unowned_sibling = profile_root.join("unowned-sibling");
        std::fs::create_dir_all(&unowned_sibling)
            .expect("create non-owned sibling beside reserved run root");
        let reserved_root = profile_root.join(&request.run_id);

        // Act
        let result = CodexSafeProfileRunPaths::create_with_config_writer(
            &scratch,
            &request,
            |_path, _contents| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected generated-config write failure",
                ))
            },
        );

        // Assert
        assert!(
            result.is_err(),
            "the injected config write must fail preparation"
        );
        assert!(
            !reserved_root.exists(),
            "a failed generated config write removes its marker-verified reserved run root"
        );
        assert!(
            unowned_sibling.exists(),
            "ownership-checked cleanup must not remove a non-owned sibling"
        );

        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[cfg(unix)]
    #[test]
    fn codex_safe_profile_fixed_jsonl_invocation_uses_no_webview_arguments() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-codex-safe-profile-fixed-invocation");
        std::fs::create_dir_all(&scratch).expect("create Codex fixture scratch directory");
        let fixture_source = scratch.join("fake_codex.rs");
        let fixture_executable = scratch.join("fake-codex");
        std::fs::write(
            &fixture_source,
            r##"
use std::io::Read;
fn has_pair(arguments: &[String], key: &str, value: &str) -> bool {
    arguments.windows(2).any(|pair| pair[0] == key && pair[1] == value)
}
fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    assert_eq!(arguments.get(9).map(String::as_str), Some("--output-schema"));
    let schema_path = std::path::PathBuf::from(arguments.get(10).expect("schema path"));
    let root = schema_path.parent().expect("schema parent");
    let expected = vec![
        "--ask-for-approval".to_string(), "never".to_string(), "exec".to_string(),
        "--ephemeral".to_string(), "--ignore-user-config".to_string(),
        "--ignore-rules".to_string(), "--sandbox".to_string(), "read-only".to_string(),
        "--json".to_string(),
        "--output-schema".to_string(), schema_path.display().to_string(),
        "--skip-git-repo-check".to_string(), "-c".to_string(), "history.persistence=\"none\"".to_string(),
        "-c".to_string(), format!("log_dir=\"{}\"", root.join("logs").display()),
        "-c".to_string(), format!("sqlite_home=\"{}\"", root.join("state").display()),
        "-c".to_string(), "features.hooks=false".to_string(),
        "-c".to_string(), "features.multi_agent=false".to_string(),
        "-c".to_string(), "features.shell_tool=false".to_string(),
        "-c".to_string(), "web_search=\"disabled\"".to_string(),
        "-c".to_string(), "mcp_servers={}".to_string(),
        "-c".to_string(), "plugins={}".to_string(),
        "-c".to_string(), "check_for_update_on_startup=false".to_string(),
        "--model".to_string(), "gpt-5".to_string(), "-".to_string(),
    ];
    assert_eq!(arguments, expected, "the broker supplies the complete fixed Codex argv");
    let schema = std::fs::read_to_string(&schema_path).expect("read app-owned output schema");
    assert!(schema.contains("\"result\""));
    assert!(schema.contains("\"additionalProperties\":false"));
    let mut prompt = String::new();
    std::io::stdin().read_to_string(&mut prompt).expect("read stdin prompt");
    assert_eq!(prompt, "review only the supplied bounded context");
    assert_eq!(
        std::env::current_dir().expect("current directory").canonicalize().expect("canonical current directory"),
        schema_path.parent().expect("schema parent").canonicalize().expect("canonical schema parent")
    );
    assert!(std::env::var_os("PRV_UNFILTERED_PARENT_VALUE").is_none());
    println!("{}", r#"{"type":"thread.started"}"#);
    println!("{}", r#"{"type":"item.completed","item":{"type":"agent_message","text":"{\"result\":{\"summary\":\"fixed contract\",\"findings\":[],\"requirementCoverage\":null,\"reportedModel\":null}}"}}"#);
    println!("{}", r#"{"type":"turn.completed"}"#);
}
"##,
        )
        .expect("write compiled fake Codex fixture source");
        let compiler = Command::new("rustc")
            .arg(&fixture_source)
            .args(["-o"])
            .arg(&fixture_executable)
            .output()
            .expect("compile fake Codex fixture");
        assert!(
            compiler.status.success(),
            "compile fake Codex fixture: {}",
            String::from_utf8_lossy(&compiler.stderr)
        );
        std::env::set_var(
            "PRV_UNFILTERED_PARENT_VALUE",
            "must-not-cross-broker-boundary",
        );
        let broker = CodexSafeProfileBroker::with_adopted_login_shell_path(OsString::from(
            "/broker-owned-path-only",
        ));
        let request = CodexSafeProfileStartRequest {
            run_id: "fixed-invocation".into(),
            pr_key: "acme/web#42".into(),
            operation: CodexSafeProfileOperation::Review,
            prompt: "review only the supplied bounded context".into(),
            model: Some("gpt-5".into()),
            provenance_receipt_id: "test-receipt".into(),
        };
        let expected_root = scratch.join("codex-safe-profile").join(&request.run_id);

        // Act
        let run = start_codex_safe_profile_with_executable(
            &broker,
            &fixture_executable,
            &scratch,
            request.clone(),
            Duration::from_secs(3),
            test_verified_launch().provenance,
        )
        .expect("start fixed Codex safe-profile fixture");
        let started = run
            .events
            .recv_timeout(Duration::from_secs(3))
            .expect("receive sanitized start event");
        let completed = loop {
            let event = run
                .events
                .recv_timeout(Duration::from_secs(3))
                .expect("receive sanitized Codex terminal event");
            if matches!(
                event,
                CodexSafeProfileEvent::Completed { .. } | CodexSafeProfileEvent::Failed { .. }
            ) {
                break event;
            }
        };
        let cleanup_deadline = Instant::now() + Duration::from_secs(3);
        while expected_root.exists() && Instant::now() < cleanup_deadline {
            std::thread::sleep(Duration::from_millis(10));
        }

        // Assert
        assert_eq!(
            started,
            CodexSafeProfileEvent::Started {
                run_id: request.run_id.clone(),
                provenance: Some(test_verified_launch().provenance),
            }
        );
        assert!(matches!(
            completed,
            CodexSafeProfileEvent::Completed { run_id, result, usage, .. }
                if run_id == request.run_id
                    && result == serde_json::json!({
                        "summary": "fixed contract",
                        "findings": [],
                        "requirementCoverage": null,
                        "reportedModel": null,
                    })
                    && usage.tool_event_count == 0
        ));
        assert!(
            !expected_root.exists(),
            "terminal processing deletes app-owned prompt, schema, config, log, and state files"
        );

        std::env::remove_var("PRV_UNFILTERED_PARENT_VALUE");
        let _ = std::fs::remove_dir_all(&scratch);
    }

    // The release gate. It runs the installed broker-resolved Codex CLI from empty app-owned
    // directories with synthetic prompts, and proves the production composition end to end: the
    // exact receipt, one real review and one real chat through the public receipt-bound start path,
    // the public queued/admitted/started/completed sequence, durable admission before `admitted`,
    // terminal-receipt retention until acknowledgement, and the fixed disabled controls. Every
    // assertion reports a derived boolean or a sanitized terminal class, so no credential, raw
    // output, environment value, repository content, executable path, or transient path is recorded.
    #[cfg(unix)]
    #[test]
    #[ignore = "requires the installed broker-resolved Codex CLI and user authentication"]
    fn codex_safe_profile_exact_receipt_release_gate_exercises_real_review_chat_and_public_state_machine(
    ) {
        // Arrange
        assert_eq!(
            std::env::var("CODEX_SAFE_PROFILE_E2E").as_deref(),
            Ok("1"),
            "the real Codex runtime gate requires explicit opt-in"
        );
        let broker = CodexSafeProfileBroker::capture_adopted_login_shell_path();
        let capability = broker.capability();
        let receipt_id = capability
            .receipt_id
            .clone()
            .expect("the available broker capability must issue an opaque receipt");
        let receipt_revalidates = broker
            .verified_receipt(&receipt_id)
            .and_then(|issued| broker.revalidate_verified_launch(&issued))
            .is_ok();
        let root = TestScratchRoot::new("prv-codex-safe-profile-runtime-gate");
        std::fs::create_dir_all(&root).expect("create app-owned empty runtime-gate root");
        let profile_root = root.join("codex-safe-profile");
        let terminal_directory = profile_root.join(CODEX_SAFE_PROFILE_TERMINAL_RECOVERY_DIRECTORY);
        // One PR key plus the production per-PR limit makes the chat turn queue behind the review,
        // so the gate observes a real queued-to-released transition rather than two parallel runs.
        let active_runs = CodexSafeProfileActiveRuns::default();
        let pr_key = "runtime-gate/empty#1";
        let review_request = CodexSafeProfileStartRequest {
            run_id: "runtime-gate-review".into(),
            pr_key: pr_key.into(),
            operation: CodexSafeProfileOperation::Review,
            prompt: "Return a concise review of this empty, app-owned context. There is no repository content. Return only the required JSON result.".into(),
            model: None,
            provenance_receipt_id: receipt_id.clone(),
        };
        let chat_request = CodexSafeProfileStartRequest {
            run_id: "runtime-gate-chat".into(),
            pr_key: pr_key.into(),
            operation: CodexSafeProfileOperation::Chat,
            prompt: "Reply to this stateless chat turn about an empty, app-owned context. There is no repository content. Return only the required JSON result.".into(),
            model: None,
            provenance_receipt_id: receipt_id.clone(),
        };
        let mut published = PublicCodexSafeProfileEventLog::default();
        let mut observed_process_groups: HashMap<String, i32> = HashMap::new();

        // Act
        let (review_queue_state, review_admitted) = public_codex_safe_profile_start(
            &broker,
            &active_runs,
            &root,
            review_request.clone(),
            &mut published,
        )
        .expect("the receipt-backed review request enters the public FIFO");
        let (chat_queue_state, _chat_pending) = public_codex_safe_profile_start(
            &broker,
            &active_runs,
            &root,
            chat_request.clone(),
            &mut published,
        )
        .expect("the receipt-backed chat request queues behind the review");
        // The fixed invocation is built from the same run-owned paths the launcher uses and is
        // inspected, never spawned. Only derived booleans and environment variable names are kept.
        let review_paths = review_admitted.paths.clone();
        let fixed_command = fixed_codex_safe_profile_command(
            &broker,
            &review_paths.executable,
            &review_request,
            &review_paths,
        );
        let fixed_arguments = fixed_command
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let mut forwarded_environment_names = fixed_command
            .get_envs()
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        forwarded_environment_names.sort();
        let generated_config =
            std::fs::read_to_string(&review_paths.config).expect("read the generated safe config");
        let mut review_admission_state_at_admitted = None;
        let mut review_liveness_at_admitted = false;
        let released = drive_admitted_codex_safe_profile_run(
            &broker,
            &active_runs,
            review_admitted,
            &mut published,
            &mut observed_process_groups,
            |run_id| {
                let run_root = profile_root.join(run_id);
                review_admission_state_at_admitted =
                    std::fs::read(run_root.join(CODEX_SAFE_PROFILE_ADMISSION_RECORD))
                        .ok()
                        .and_then(|bytes| {
                            serde_json::from_slice::<CodexSafeProfileAdmissionRecord>(&bytes).ok()
                        })
                        .map(|record| record.state);
                review_liveness_at_admitted =
                    run_root.join(CODEX_SAFE_PROFILE_LIVENESS_RECORD).is_file();
            },
        );
        let chat_admitted = released.expect("the review terminal releases the queued chat turn");
        let queue_drained = drive_admitted_codex_safe_profile_run(
            &broker,
            &active_runs,
            chat_admitted,
            &mut published,
            &mut observed_process_groups,
            |_| {},
        )
        .is_none();
        let review_root_removed =
            wait_for_run_root_removal(&profile_root.join(&review_request.run_id));
        let chat_root_removed = wait_for_run_root_removal(&profile_root.join(&chat_request.run_id));
        let group_observations = [&review_request.run_id, &chat_request.run_id]
            .into_iter()
            .map(|run_id| {
                observed_process_groups
                    .get(run_id)
                    .copied()
                    .map(process_group_exists)
            })
            .collect::<Vec<_>>();
        let receipts_before_acknowledgement = sorted_directory_entry_names(&terminal_directory);
        let retained_receipt_contents = receipts_before_acknowledgement
            .iter()
            .filter_map(|run_id| std::fs::read_to_string(terminal_directory.join(run_id)).ok())
            .collect::<Vec<_>>();
        let recovery = CodexSafeProfileStartupRecovery::default();
        let mut reported_run_ids = recover_codex_safe_profile_transients(&root)
            .expect("startup recovery reports the retained terminal receipts");
        reported_run_ids.sort();
        recovery.replace_safely_resolved_run_ids(reported_run_ids.clone());
        acknowledge_codex_safe_profile_recovered_runs(&root, &recovery, &reported_run_ids);
        let receipts_after_acknowledgement = sorted_directory_entry_names(&terminal_directory);

        // Assert
        let lifecycle = |run_id: &str| {
            published
                .labels
                .iter()
                .filter(|(event_run_id, label)| event_run_id == run_id && label != "progress")
                .map(|(_, label)| label.as_str())
                .collect::<Vec<_>>()
        };
        let terminal_for = |run_id: &str| {
            published
                .terminals
                .iter()
                .find(|event| match event {
                    CodexSafeProfileEvent::Completed {
                        run_id: event_run_id,
                        ..
                    }
                    | CodexSafeProfileEvent::Failed {
                        run_id: event_run_id,
                        ..
                    } => event_run_id == run_id,
                    _ => false,
                })
                .expect("every driven run publishes a bounded terminal event")
        };
        assert!(
            capability.available
                && capability.core_controls_verified
                && capability.diagnostics.is_empty(),
            "the installed Codex CLI satisfies the exact safe-profile contract"
        );
        assert_eq!(
            capability.cli_version.as_deref(),
            Some(CODEX_SAFE_PROFILE_EXACT_CLI_VERSION),
            "the gate runs only against the exact supported CLI version"
        );
        assert!(
            receipt_revalidates,
            "the issued opaque receipt revalidates against a freshly observed descriptor"
        );
        assert_eq!(review_queue_state, AiBrokerQueueState::Started);
        assert_eq!(chat_queue_state, AiBrokerQueueState::Queued);
        // Provider-driven progress events are filtered out; the lifecycle order itself is exact.
        assert_eq!(
            lifecycle(&review_request.run_id),
            vec!["admitted", "started", "completed"],
            "the real review follows the public admission and terminal sequence"
        );
        assert_eq!(
            lifecycle(&chat_request.run_id),
            vec!["queued", "admitted", "started", "completed"],
            "the released chat turn follows the public queued-to-completed sequence"
        );
        let review_terminal = terminal_for(&review_request.run_id);
        let valid_review = matches!(
            review_terminal,
            CodexSafeProfileEvent::Completed { result, usage, .. }
                if result.get("summary").and_then(serde_json::Value::as_str).is_some_and(|summary| !summary.is_empty())
                    && result.get("findings").and_then(serde_json::Value::as_array).is_some()
                    && result.get("requirementCoverage").is_some()
                    && result.get("reportedModel").is_some()
                    && usage.tool_event_count == 0
        );
        assert!(
            valid_review,
            "the real review completes through the closed full schema (terminal class: {})",
            sanitized_terminal_class(review_terminal)
        );
        let chat_terminal = terminal_for(&chat_request.run_id);
        let valid_chat = matches!(
            chat_terminal,
            CodexSafeProfileEvent::Completed { result, usage, .. }
                if result.get("message").and_then(serde_json::Value::as_str).is_some_and(|message| !message.is_empty())
                    && result.get("findingCandidate").is_some()
                    && result.get("reportedModel").is_some()
                    && usage.tool_event_count == 0
        );
        assert!(
            valid_chat,
            "the real chat turn completes through the closed full schema (terminal class: {})",
            sanitized_terminal_class(chat_terminal)
        );
        assert_eq!(
            review_admission_state_at_admitted,
            Some(CodexSafeProfileAdmissionState::Active),
            "durable active admission evidence is committed before the public admitted event"
        );
        assert!(
            review_liveness_at_admitted,
            "owned process-group liveness evidence is committed before the public admitted event"
        );
        assert!(
            queue_drained,
            "the last terminal leaves no admitted or pending request behind"
        );
        assert_eq!(
            group_observations,
            vec![Some(Ok(false)), Some(Ok(false))],
            "each run's owned process group is observed to hold no live process"
        );
        assert!(
            review_root_removed && chat_root_removed,
            "each run root is removed only after that group-absence observation"
        );
        assert_eq!(
            receipts_before_acknowledgement,
            vec![chat_request.run_id.clone(), review_request.run_id.clone()],
            "an opaque terminal receipt per run is the only evidence that outlives its run root"
        );
        assert_eq!(
            reported_run_ids, receipts_before_acknowledgement,
            "startup recovery reports exactly the retained terminal receipts"
        );
        assert!(
            receipts_after_acknowledgement.is_empty(),
            "a retained receipt is deleted only once acknowledgement reports its durable interruption"
        );
        let disclosing_receipt = retained_receipt_contents.iter().any(|receipt| {
            receipt.contains(&review_request.prompt)
                || receipt.contains(&chat_request.prompt)
                || receipt.contains("/codex")
                || receipt.contains(root.to_string_lossy().as_ref())
        });
        assert!(
            !disclosing_receipt,
            "terminal recovery evidence retains no prompt, executable path, or transient path"
        );
        let required_controls = [
            "--ask-for-approval",
            "never",
            "exec",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--sandbox",
            "read-only",
            "--json",
            "--output-schema",
            "--skip-git-repo-check",
            "-",
        ];
        assert!(
            required_controls
                .iter()
                .all(|control| fixed_arguments.iter().any(|argument| argument == control)),
            "the fixed invocation carries every required safe-profile control"
        );
        let disabled_controls = [
            "history.persistence=\"none\"",
            "features.hooks=false",
            "features.multi_agent=false",
            "features.shell_tool=false",
            "web_search=\"disabled\"",
            "mcp_servers={}",
            "plugins={}",
            "check_for_update_on_startup=false",
        ];
        assert!(
            disabled_controls
                .iter()
                .all(|control| fixed_arguments.iter().any(|argument| argument == control)),
            "every advanced capability stays fixed disabled in the invocation"
        );
        let webview_influenced_argument = fixed_arguments.iter().any(|argument| {
            argument.contains(&review_request.prompt)
                || argument.contains(&review_request.pr_key)
                || argument == "--model"
                || argument.contains("danger")
                || argument.contains("full-auto")
                || argument.contains("workspace-write")
        });
        assert!(
            !webview_influenced_argument,
            "no webview-supplied value and no relaxed control reaches the fixed argument list"
        );
        let allowed_environment_names = ["HOME", "LANG", "LC_ALL", "NO_COLOR", "PATH", "TMPDIR"];
        assert!(
            forwarded_environment_names
                .iter()
                .all(|name| allowed_environment_names.contains(&name.as_str()))
                && forwarded_environment_names
                    .iter()
                    .any(|name| name == "PATH")
                && forwarded_environment_names
                    .iter()
                    .any(|name| name == "NO_COLOR"),
            "the filtered environment forwards only the fixed allowed variable names"
        );
        let disabled_settings = [
            "history.persistence = \"none\"",
            "web_search = \"disabled\"",
            "check_for_update_on_startup = false",
            "mcp_servers = {}",
            "plugins = {}",
            "hooks = false",
            "multi_agent = false",
            "shell_tool = false",
        ];
        assert!(
            disabled_settings
                .iter()
                .all(|setting| generated_config.contains(setting)),
            "the generated app-owned profile reports every advanced capability disabled"
        );
    }

    #[cfg(unix)]
    #[test]
    fn webview_has_no_ai_executable_discovery_or_probe_command() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-ai-command-surface");
        std::fs::create_dir_all(&scratch).expect("create command-surface scratch directory");
        let fabricated_executable = scratch.join("claude");
        let fabricated_marker = scratch.join("fabricated-ran");
        std::fs::write(
            &fabricated_executable,
            format!("#!/bin/sh\ntouch '{}'\n", fabricated_marker.display()),
        )
        .expect("write basename-matching fabricated executable");
        let command_surface = include_str!("lib.rs");

        // Act
        let registered_ai_commands = ["ai_discover_executable", "ai_probe_capabilities"]
            .into_iter()
            .filter(|command| command_surface.contains(command))
            .collect::<Vec<_>>();

        // Assert
        assert!(
            registered_ai_commands.is_empty(),
            "the Tauri command surface must not register AI executable discovery or probing"
        );
        assert!(
            !fabricated_marker.exists(),
            "a fabricated claude executable cannot be invoked without a Tauri discovery or probe command"
        );

        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[cfg(unix)]
    fn wait_for_event(
        events: &Receiver<AiBrokerEvent>,
        predicate: impl Fn(&AiBrokerEvent) -> bool,
    ) -> AiBrokerEvent {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let event = events
                .recv_timeout(remaining)
                .expect("broker emitted the expected event before the deadline");
            if predicate(&event) {
                return event;
            }
        }
    }

    #[cfg(unix)]
    fn wait_for_process_exit(pid: i32) -> bool {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let result = unsafe { libc::kill(pid, 0) };
            if result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[cfg(unix)]
    #[test]
    fn parent_exit_waits_for_term_resistant_descendant_cleanup() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-ai-broker-parent-exit");
        std::fs::create_dir_all(&scratch).expect("create broker test scratch directory");
        let descendant_pid_file = scratch.join("descendant.pid");
        let run_id = "parent-exit-tree".to_string();
        let command = crate::ai_broker_test_child::term_resistant_descendant_fixture_command(
            &descendant_pid_file,
        );
        let run = start_broker_process(run_id.clone(), command, Duration::from_secs(10))
            .expect("start TERM-resistant fake broker child");
        let _started = wait_for_event(
            &run.events,
            |event| matches!(event, AiBrokerEvent::Started { run_id: event_run_id } if event_run_id == &run_id),
        );
        let _ready = wait_for_event(
            &run.events,
            |event| matches!(event, AiBrokerEvent::Stdout { line, .. } if line == "fixture-term-resistant-ready"),
        );
        let descendant_pid: i32 = std::fs::read_to_string(&descendant_pid_file)
            .expect("read TERM-resistant fixture descendant PID")
            .parse()
            .expect("parse TERM-resistant fixture descendant PID");

        // Act
        let cancellation_started_at = Instant::now();
        run.cancel().expect("cancel the broker process tree");
        let terminal = wait_for_event(
            &run.events,
            |event| matches!(event, AiBrokerEvent::Cancelled { run_id: event_run_id } if event_run_id == &run_id),
        );

        // Assert
        assert!(
            cancellation_started_at.elapsed() >= PROCESS_TERMINATION_GRACE,
            "the broker must give TERM-resistant descendants a bounded grace period before SIGKILL"
        );
        assert!(
            wait_for_process_exit(descendant_pid),
            "terminal completion must wait until SIGKILL removes the TERM-resistant descendant"
        );
        assert_eq!(terminal, AiBrokerEvent::Cancelled { run_id });

        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_kills_the_full_process_tree() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-ai-broker-cancel");
        std::fs::create_dir_all(&scratch).expect("create broker test scratch directory");
        let descendant_pid_file = scratch.join("descendant.pid");
        let run_id = "cancel-tree".to_string();
        let command = crate::ai_broker_test_child::fixture_command(&descendant_pid_file);
        let run = start_broker_process(run_id.clone(), command, Duration::from_secs(10))
            .expect("start fake broker child");
        let _started = wait_for_event(
            &run.events,
            |event| matches!(event, AiBrokerEvent::Started { run_id: event_run_id } if event_run_id == &run_id),
        );
        let _ready = wait_for_event(
            &run.events,
            |event| matches!(event, AiBrokerEvent::Stdout { line, .. } if line == "fixture-ready"),
        );
        let descendant_pid: i32 = std::fs::read_to_string(&descendant_pid_file)
            .expect("read fixture descendant PID")
            .parse()
            .expect("parse fixture descendant PID");

        // Act
        run.cancel().expect("cancel the broker process tree");
        let terminal = wait_for_event(
            &run.events,
            |event| matches!(event, AiBrokerEvent::Cancelled { run_id: event_run_id } if event_run_id == &run_id),
        );

        // Assert
        assert_eq!(terminal, AiBrokerEvent::Cancelled { run_id });
        assert!(
            wait_for_process_exit(descendant_pid),
            "the nested fixture process must exit with its broker parent"
        );

        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[cfg(unix)]
    #[test]
    fn timeout_terminates_the_provider_process_tree() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-ai-broker-timeout");
        std::fs::create_dir_all(&scratch).expect("create broker test scratch directory");
        let descendant_pid_file = scratch.join("descendant.pid");
        let run_id = "timeout-tree".to_string();
        let command = crate::ai_broker_test_child::fixture_command(&descendant_pid_file);
        let run = start_broker_process(run_id.clone(), command, Duration::from_millis(50))
            .expect("start fake broker child");
        let _started = wait_for_event(
            &run.events,
            |event| matches!(event, AiBrokerEvent::Started { run_id: event_run_id } if event_run_id == &run_id),
        );
        let _ready = wait_for_event(
            &run.events,
            |event| matches!(event, AiBrokerEvent::Stdout { line, .. } if line == "fixture-ready"),
        );
        let descendant_pid: i32 = std::fs::read_to_string(&descendant_pid_file)
            .expect("read fixture descendant PID")
            .parse()
            .expect("parse fixture descendant PID");

        // Act
        let terminal = wait_for_event(
            &run.events,
            |event| matches!(event, AiBrokerEvent::TimedOut { run_id: event_run_id } if event_run_id == &run_id),
        );

        // Assert
        assert_eq!(terminal, AiBrokerEvent::TimedOut { run_id });
        assert!(
            wait_for_process_exit(descendant_pid),
            "the timed-out nested fixture process must exit"
        );

        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[cfg(unix)]
    #[test]
    fn bounded_jsonl_framing_rejects_oversized_truncated_and_decode_failed_frames() {
        // Arrange
        let fixtures = [
            "fixture_emits_oversized_frame",
            "fixture_emits_truncated_frame",
            "fixture_emits_decode_failed_frame",
        ];

        // Act
        struct ReadFailure;
        impl std::io::Read for ReadFailure {
            fn read(&mut self, _buffer: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("fixture read failure"))
            }
        }
        let read_failure_flag = Arc::new(AtomicBool::new(false));
        let (read_failure_events, _unused_events) = mpsc::channel();
        let read_failure_drain = stream_child_output(
            ReadFailure,
            "read-failure".into(),
            read_failure_events,
            false,
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
            8,
            128,
            Arc::clone(&read_failure_flag),
            Arc::new(AtomicBool::new(false)),
            64,
        );
        read_failure_drain
            .completed
            .recv_timeout(Duration::from_secs(1))
            .expect("read failure finishes the bounded drain");
        let terminals = fixtures
            .into_iter()
            .map(|fixture| {
                let run_id = format!("bounded-frame-{fixture}");
                let run = start_broker_process_with_input(
                    run_id.clone(),
                    crate::ai_broker_test_child::output_fixture_command(fixture),
                    Duration::from_secs(3),
                    None,
                    8,
                    128,
                    64,
                )
                .expect("start bounded-output fixture");
                wait_for_event(&run.events, |event| {
                    matches!(event, AiBrokerEvent::OutputLimitExceeded { run_id: event_run_id } if event_run_id == &run_id)
                })
            })
            .collect::<Vec<_>>();

        // Assert
        assert_eq!(terminals.len(), 3);
        assert!(
            read_failure_flag.load(Ordering::SeqCst),
            "pipe read failures are terminal-invalid rather than silently ignored"
        );
        assert!(terminals.iter().all(|event| matches!(event, AiBrokerEvent::OutputLimitExceeded { .. })),
            "oversized, truncated, and non-UTF-8 frames are terminal-invalid rather than best-effort output");
    }

    #[cfg(unix)]
    #[test]
    fn detached_pipe_holding_fixture_cannot_block_terminal_completion() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-ai-broker-detached-pipe");
        std::fs::create_dir_all(&scratch).expect("create detached-pipe fixture directory");
        let descendant_pid_file = scratch.join("descendant.pid");
        let run_id = "detached-pipe-holder".to_string();
        let run = start_broker_process(
            run_id.clone(),
            crate::ai_broker_test_child::detached_pipe_holding_fixture_command(
                &descendant_pid_file,
            ),
            Duration::from_secs(3),
        )
        .expect("start detached pipe-holding fixture");
        let _started = wait_for_event(
            &run.events,
            |event| matches!(event, AiBrokerEvent::Started { run_id: event_run_id } if event_run_id == &run_id),
        );
        let _ready = wait_for_event(
            &run.events,
            |event| matches!(event, AiBrokerEvent::Stdout { line, .. } if line == "fixture-detached-pipe-ready"),
        );
        let descendant_pid: i32 = std::fs::read_to_string(&descendant_pid_file)
            .expect("read detached pipe-holding fixture PID")
            .parse()
            .expect("parse detached pipe-holding fixture PID");

        // Act
        let terminal_started_at = Instant::now();
        let terminal = wait_for_event(
            &run.events,
            |event| matches!(event, AiBrokerEvent::OutputLimitExceeded { run_id: event_run_id } if event_run_id == &run_id),
        );
        unsafe {
            libc::kill(descendant_pid, libc::SIGKILL);
        }

        // Assert
        assert_eq!(terminal, AiBrokerEvent::OutputLimitExceeded { run_id });
        assert!(
            terminal_started_at.elapsed() < BROKER_OUTPUT_DRAIN_TIMEOUT + Duration::from_secs(1),
            "a detached descendant retaining inherited pipes cannot block terminal completion"
        );
        assert!(
            wait_for_process_exit(descendant_pid),
            "the test cleans its deliberately escaped descendant after proving the drain deadline"
        );

        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[cfg(unix)]
    fn fixture_help_digest(exec_help: &str) -> String {
        digest_codex_provenance(&[
            b"--ask-for-approval never -c\n",
            b"\n--exec-help--\n",
            format!("{exec_help}\n").as_bytes(),
        ])
    }

    #[cfg(unix)]
    fn fixture_broker(path: &Path, exec_help: &str) -> CodexSafeProfileBroker {
        CodexSafeProfileBroker::with_compatibility_contract(
            path.into(),
            CODEX_SAFE_PROFILE_EXACT_CLI_VERSION,
            fixture_help_digest(exec_help),
            CODEX_SAFE_PROFILE_REVISION,
        )
    }

    #[cfg(unix)]
    fn write_codex_compatibility_fixture(path: &Path, version: &str, exec_help: &str) {
        use std::os::unix::fs::PermissionsExt;

        let script = format!(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  printf '%s\\n' 'codex-cli {version}'\nelif [ \"$1\" = \"--help\" ]; then\n  printf '%s\\n' '--ask-for-approval never -c'\nelif [ \"$1\" = \"exec\" ] && [ \"$2\" = \"--help\" ]; then\n  printf '%s\\n' '{exec_help}'\nelse\n  exit 64\nfi\n"
        );
        std::fs::write(path, script).expect("write bounded Codex compatibility fixture");
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .expect("make Codex compatibility fixture executable");
    }

    #[cfg(unix)]
    fn shell_single_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\"'\"'"))
    }

    // A fixture's `exec --help` output and the broker's fixed help digest must agree exactly, so
    // both sides read this one declaration.
    #[cfg(unix)]
    const CODEX_FIXTURE_EXEC_HELP: &str = "--ephemeral --ignore-user-config --ignore-rules --sandbox read-only --json --output-schema --skip-git-repo-check";

    // `fixed_codex_safe_profile_command` clears the environment and sets `PATH` to the fixture's
    // own directory, so inside a fixture only shell builtins and absolute paths resolve. A bare
    // `cat` is silently "not found": the fixture then exits without draining stdin and the
    // broker's synchronous small-prompt write races the child's exit with `EPIPE`.
    #[cfg(unix)]
    const CODEX_OUTPUT_LIMIT_FIXTURE_TEMPLATE: &str = r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\n' 'codex-cli 0.153.4'
elif [ "$1" = "--help" ]; then
  printf '%s\n' '--ask-for-approval never -c'
elif [ "$1" = "exec" ] && [ "$2" = "--help" ]; then
  printf '%s\n' '__EXEC_HELP__'
else
  /bin/cat > __PROMPT_DIRECTORY__/prompt-$$
  case " $* " in
    *" --model overflow "*)
      PRV_AI_TERM_RESISTANT_FIXTURE=1 PRV_AI_TERM_RESISTANT_READY_FILE=__READY_FILE__ \
        __TEST_BINARY__ --exact ai_broker_test_child::fixture_ignores_term --nocapture \
        3>&1 >/dev/null 2>/dev/null &
      waited=0
      while [ ! -f __READY_FILE__ ] && [ "$waited" -lt 500 ]; do
        /bin/sleep 0.01
        waited=$((waited + 1))
      done
      emitted=0
      while [ "$emitted" -lt __OVERFLOW_LINES__ ]; do
        printf '%s\n' '{"type":"item.started"}'
        emitted=$((emitted + 1))
      done
      wait
      exit 0
      ;;
  esac
  printf '%s\n' '__TERMINAL_LINE__'
fi
"#;

    // `--model overflow` selects the retained-sender overflow behaviour. A TERM-resistant
    // descendant stays in the broker-created process group and keeps the inherited stdout pipe
    // open on descriptor 3 — its own stdout goes to /dev/null so its test-harness banner never
    // enters the JSONL stream. The leader then overruns the bounded JSONL line budget and blocks
    // in `wait`, so the owned group outlives the public terminal exactly as a real nested helper
    // would. Every other invocation drains the prompt and emits one valid terminal object.
    #[cfg(unix)]
    fn write_codex_output_limit_fixture(
        path: &Path,
        prompt_directory: &Path,
        term_resistant_ready_file: &Path,
    ) {
        use std::os::unix::fs::PermissionsExt;

        std::fs::create_dir_all(prompt_directory)
            .expect("create the Codex output-limit fixture prompt directory");
        let test_binary = shell_single_quote(
            &std::env::current_exe()
                .expect("locate Rust test binary")
                .to_string_lossy(),
        );
        let terminal_line = r#"{"type":"item.completed","item":{"type":"agent_message","text":"{\"result\":{\"summary\":\"queued complete\",\"findings\":[],\"requirementCoverage\":null,\"reportedModel\":null}}"}}"#;
        let overflow_lines = CODEX_SAFE_PROFILE_MAX_JSONL_LINES + 8;
        let script = CODEX_OUTPUT_LIMIT_FIXTURE_TEMPLATE
            .replace("__EXEC_HELP__", CODEX_FIXTURE_EXEC_HELP)
            .replace(
                "__PROMPT_DIRECTORY__",
                &shell_single_quote(&prompt_directory.to_string_lossy()),
            )
            .replace(
                "__READY_FILE__",
                &shell_single_quote(&term_resistant_ready_file.to_string_lossy()),
            )
            .replace("__TEST_BINARY__", &test_binary)
            .replace("__OVERFLOW_LINES__", &overflow_lines.to_string())
            .replace("__TERMINAL_LINE__", terminal_line);
        std::fs::write(path, script).expect("write Codex output-limit fixture");
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .expect("make Codex output-limit fixture executable");
    }

    #[cfg(unix)]
    #[test]
    fn output_limit_invalid_output_releases_queued_safe_profile_run_without_retained_sender_wait() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-codex-safe-profile-output-limit");
        std::fs::create_dir_all(&scratch).expect("create output-limit fixture directory");
        write_codex_output_limit_fixture(
            &scratch.join("codex"),
            &scratch.join("prompts"),
            &scratch.join("term-resistant-holder.ready"),
        );
        let broker = fixture_broker(&scratch, CODEX_FIXTURE_EXEC_HELP);
        let verified_launch = broker
            .probe_verified_launch()
            .expect("fixture has compatible broker-owned provenance");
        let active_runs = CodexSafeProfileActiveRuns {
            state: Mutex::new(CodexSafeProfileRunState {
                queue: AiBrokerQueue::new(1, 1).expect("valid fixed queue limit"),
                controls: HashMap::new(),
                published_terminals: VecDeque::new(),
                shutting_down: false,
            }),
        };
        let overflow_request = CodexSafeProfileStartRequest {
            run_id: "overflow-run".into(),
            pr_key: "acme/web#42".into(),
            operation: CodexSafeProfileOperation::Review,
            prompt: "overflow-fixture".into(),
            model: Some("overflow".into()),
            provenance_receipt_id: "fixture-receipt".into(),
        };
        let queued_request = CodexSafeProfileStartRequest {
            run_id: "queued-run".into(),
            pr_key: "acme/api#7".into(),
            operation: CodexSafeProfileOperation::Review,
            prompt: "queued-fixture".into(),
            model: None,
            provenance_receipt_id: "fixture-receipt".into(),
        };
        let overflow_paths = CodexSafeProfileRunPaths::create(&scratch, &overflow_request)
            .expect("reserve the production safe-profile overflow run root");
        let queued_paths = CodexSafeProfileRunPaths::create(&scratch, &queued_request)
            .expect("reserve the production safe-profile queued run root");
        assert_eq!(
            active_runs
                .enqueue(
                    overflow_request.clone(),
                    overflow_paths.clone(),
                    verified_launch.clone()
                )
                .expect("overflow fixture receives admission"),
            AiBrokerQueueState::Started
        );
        assert_eq!(
            active_runs
                .enqueue(
                    queued_request.clone(),
                    queued_paths.clone(),
                    verified_launch.clone()
                )
                .expect("next compatible fixture queues"),
            AiBrokerQueueState::Queued
        );
        let (raw_events, raw_receiver) = mpsc::channel();
        raw_events
            .send(AiBrokerEvent::Started {
                run_id: overflow_request.run_id.clone(),
            })
            .expect("send started fixture event");
        raw_events
            .send(AiBrokerEvent::OutputLimitExceeded {
                run_id: overflow_request.run_id.clone(),
            })
            .expect("send output-limit fixture event");
        drop(raw_events);
        let overflow_run = stream_codex_safe_profile_output(
            overflow_request.run_id.clone(),
            overflow_request.operation,
            AiBrokerRun {
                events: raw_receiver,
                cancellation: AiBrokerCancellation {
                    process_group: 0,
                    cancelled: Arc::new(AtomicBool::new(false)),
                },
                stdin: Arc::new(Mutex::new(None)),
            },
            overflow_paths,
            Instant::now(),
            verified_launch.provenance.clone(),
        );
        let overflow_preparing = active_runs
            .begin_preparing(&overflow_request.run_id)
            .expect("overflow fixture enters preparing before active registration");
        active_runs
            .register_active(
                &overflow_request.run_id,
                overflow_run.cancellation.clone(),
                &overflow_preparing,
            )
            .expect("register admitted overflow fixture");

        // Act
        let overflow_started = overflow_run
            .events
            .recv_timeout(Duration::from_secs(3))
            .expect("production stream emits its started event");
        let overflow_terminal = overflow_run
            .events
            .recv_timeout(Duration::from_secs(3))
            .unwrap_or_else(|_| {
                panic!(
                    "output limit emits its terminal failure without pipe closure after {overflow_started:?}"
                )
            });
        let overflow_events = vec![overflow_started, overflow_terminal];
        let next = active_runs
            .release(&overflow_request.run_id)
            .expect("terminal output failure releases admission")
            .expect("queued fixture receives released slot");
        let queued_preparing = active_runs
            .begin_preparing(&queued_request.run_id)
            .expect("released fixture enters preparing before active registration");
        let queued_run = start_codex_safe_profile(
            &broker,
            next.request.clone(),
            next.paths,
            next.verified_launch,
            &queued_preparing,
        )
        .expect("released queue slot starts the fixed safe-profile command");
        active_runs
            .register_active(
                &queued_request.run_id,
                queued_run.cancellation.clone(),
                &queued_preparing,
            )
            .expect("register released queued fixture");
        let queued_started = queued_run
            .events
            .recv_timeout(Duration::from_secs(3))
            .expect("released queued fixture emits its started event");
        let _ = active_runs.release(&queued_request.run_id);

        // Assert
        assert_eq!(
            overflow_events,
            vec![
                CodexSafeProfileEvent::Started {
                    run_id: "overflow-run".into(),
                    provenance: Some(verified_launch.provenance.clone()),
                },
                CodexSafeProfileEvent::Failed {
                    run_id: "overflow-run".into(),
                    code: "invalid-output".into(),
                    provenance: Some(verified_launch.provenance.clone()),
                },
            ],
            "the production stream exposes exactly one sanitized invalid-output terminal"
        );
        assert!(
            matches!(queued_started, CodexSafeProfileEvent::Started { .. }),
            "the queued fixed-profile run starts immediately after the output-limit terminal"
        );

        // The production stream thread terminalizes after its terminal event and recreates
        // app-owned recovery evidence as it goes. Letting it finish keeps it from racing the
        // scratch guard's cleanup and leaving an abandoned directory behind.
        let _ = wait_for_run_root_removal(&queued_paths.root);
    }

    #[cfg(unix)]
    #[test]
    fn broker_verified_provenance_binds_probe_queue_launch_and_persisted_review() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-codex-safe-profile-compatibility");
        std::fs::create_dir_all(&scratch).expect("create compatibility fixture directory");
        let compatible = scratch.join("codex");
        let controls = "--ephemeral --ignore-user-config --ignore-rules --sandbox read-only --json --output-schema --skip-git-repo-check";
        write_codex_compatibility_fixture(&compatible, "0.153.4", controls);
        let compatible_broker = fixture_broker(&scratch, controls);
        let incompatible = scratch.join("incompatible");
        write_codex_compatibility_fixture(&incompatible, "0.1.0", controls);
        let incompatible_broker = fixture_broker(&scratch, controls);
        std::fs::rename(&compatible, scratch.join("compatible-codex"))
            .expect("preserve compatible fixture");
        std::fs::rename(&incompatible, scratch.join("codex"))
            .expect("install incompatible fixture at the broker-owned name");
        let missing_control_broker = fixture_broker(&scratch, controls);
        let malicious_request = serde_json::json!({
            "runId": "probe-run",
            "prKey": "acme/web#42",
            "operation": "review",
            "prompt": "app-owned prompt",
            "model": null,
            "executable": "/untrusted/codex",
            "arguments": ["--danger-full-access"]
        });

        // Act
        let incompatible_capability = incompatible_broker.capability();
        std::fs::remove_file(scratch.join("codex")).expect("remove incompatible fixture");
        std::fs::rename(scratch.join("compatible-codex"), scratch.join("codex"))
            .expect("restore compatible fixture");
        let compatible_capability = compatible_broker.capability();
        write_codex_compatibility_fixture(&scratch.join("codex"), "0.153.4", "--ephemeral");
        let missing_control_capability = missing_control_broker.capability();
        let parsed_malicious_request =
            serde_json::from_value::<CodexSafeProfileStartRequest>(malicious_request);

        // Assert
        assert_eq!(
            incompatible_capability.cli_version.as_deref(),
            Some("0.1.0")
        );
        assert!(!incompatible_capability.core_controls_verified);
        assert!(incompatible_capability
            .diagnostics
            .iter()
            .any(|diagnostic| {
                diagnostic
                    == "The resolved Codex CLI version is incompatible with the safe profile."
            }));
        assert_eq!(
            compatible_capability.cli_version.as_deref(),
            Some("0.153.4")
        );
        assert!(compatible_capability.core_controls_verified);
        assert!(
            compatible_capability.available,
            "S92 re-enables only a compatible broker-verified profile"
        );
        assert_eq!(
            compatible_capability
                .provenance
                .as_ref()
                .map(|provenance| provenance.cli_version.as_str()),
            Some("0.153.4"),
            "the broker emits observed, not hardcoded, version provenance"
        );
        assert!(compatible_capability
            .provenance
            .as_ref()
            .is_some_and(
                |provenance| provenance.executable_identity_digest.len() == 64
                    && provenance.help_digest.len() == 64
                    && provenance.safe_profile_revision == CODEX_SAFE_PROFILE_REVISION
            ));
        assert!(compatible_capability.receipt_id.is_some());
        assert!(
            compatible_capability.diagnostics.is_empty(),
            "the exact S92-gated profile exposes no unavailable-gate diagnostic"
        );
        assert_eq!(
            missing_control_capability.cli_version.as_deref(),
            Some("0.153.4")
        );
        assert!(!missing_control_capability.core_controls_verified);
        assert!(!missing_control_capability.available);
        assert!(
            parsed_malicious_request.is_err(),
            "the no-argument capability path cannot accept executable or argv input"
        );

        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[cfg(unix)]
    #[test]
    fn immutable_observed_identity_cache_reprobes_after_executable_help_or_profile_mismatch() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-codex-safe-profile-s87-identity");
        std::fs::create_dir_all(&scratch).expect("create identity fixture directory");
        let controls = "--ephemeral --ignore-user-config --ignore-rules --sandbox read-only --json --output-schema --skip-git-repo-check";
        let executable = scratch.join("codex");
        write_codex_compatibility_fixture(&executable, "0.153.4", controls);
        let broker = fixture_broker(&scratch, controls);
        let first = broker
            .probe_verified_launch()
            .expect("probe the first descriptor identity");
        let mut profile_mismatch = first.clone();
        profile_mismatch.provenance.safe_profile_revision = "different-broker-profile".into();

        // Act
        write_codex_compatibility_fixture(
            &executable,
            "0.153.4",
            "--ephemeral --ignore-user-config --ignore-rules --sandbox read-only --json --output-schema --skip-git-repo-check --different-help",
        );
        let changed_help_capability = broker
            .probe_verified_launch()
            .expect_err("a changed fixed help contract must be unavailable");
        let stale_admission = broker.revalidate_verified_launch(&first);
        let profile_admission = broker.revalidate_verified_launch(&profile_mismatch);
        let cache_entries = broker
            .verified_probe_cache
            .lock()
            .expect("inspect broker-only identity cache")
            .len();

        // Assert
        assert!(
            !changed_help_capability.available
                && changed_help_capability.receipt_id.is_none()
                && changed_help_capability.provenance.is_none(),
            "a changed help contract cannot issue a replacement receipt"
        );
        assert!(
            stale_admission.is_err(),
            "a receipt from the replaced descriptor cannot be admitted"
        );
        assert!(
            profile_admission.is_err(),
            "a safe-profile revision mismatch cannot reuse otherwise matching probe facts"
        );
        assert_eq!(
            cache_entries, 1,
            "an incompatible changed descriptor is not retained as a compatible cache entry"
        );

        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[cfg(unix)]
    fn write_codex_prompt_fixture(path: &Path, prompt_file: &Path) {
        use std::os::unix::fs::PermissionsExt;

        let prompt_file = shell_single_quote(&prompt_file.to_string_lossy());
        let script = format!(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  printf '%s\\n' 'codex-cli 0.153.4'\nelif [ \"$1\" = \"--help\" ]; then\n  printf '%s\\n' '--ask-for-approval never -c'\nelif [ \"$1\" = \"exec\" ] && [ \"$2\" = \"--help\" ]; then\n  printf '%s\\n' '--ephemeral --ignore-user-config --ignore-rules --sandbox read-only --json --output-schema --skip-git-repo-check'\nelse\n  /bin/cat > {prompt_file}\n  printf '%s\\n' '{{\"type\":\"item.completed\",\"item\":{{\"type\":\"agent_message\",\"text\":\"{{\\\"result\\\":{{\\\"summary\\\":\\\"descriptor complete\\\",\\\"findings\\\":[],\\\"requirementCoverage\\\":null,\\\"reportedModel\\\":null}}}}\"}}}}'\nfi\n"
        );
        std::fs::write(path, script).expect("write descriptor-backed prompt fixture");
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .expect("make descriptor-backed prompt fixture executable");
    }

    #[cfg(unix)]
    #[test]
    fn path_replacement_before_prompt_delivery_never_discloses_stdin_to_replaced_instance() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-codex-safe-profile-s87-replacement");
        std::fs::create_dir_all(&scratch).expect("create replacement fixture directory");
        let executable = scratch.join("codex");
        let observed_prompt = scratch.join("observed-prompt");
        let replaced_prompt = scratch.join("replaced-prompt");
        write_codex_prompt_fixture(&executable, &observed_prompt);
        let broker = fixture_broker(
            &scratch,
            "--ephemeral --ignore-user-config --ignore-rules --sandbox read-only --json --output-schema --skip-git-repo-check",
        );
        let verified = broker
            .probe_verified_launch()
            .expect("capture the first opened descriptor bytes");
        let request = CodexSafeProfileStartRequest {
            run_id: "descriptor-run".into(),
            pr_key: "acme/web#42".into(),
            operation: CodexSafeProfileOperation::Review,
            prompt: "only-the-observed-materialization-may-read-this".into(),
            model: None,
            provenance_receipt_id: "fixture-receipt".into(),
        };

        // Act
        let replacement = scratch.join("replacement-codex");
        write_codex_prompt_fixture(&replacement, &replaced_prompt);
        std::fs::rename(&replacement, &executable)
            .expect("atomically replace the broker PATH entry after probing");
        let stale_admission = broker.revalidate_verified_launch(&verified);
        let run = start_codex_safe_profile_with_verified_launch(
            &broker,
            &scratch,
            request,
            Duration::from_secs(3),
            verified,
        )
        .expect("the private descriptor-materialization fixture starts with stdin still closed");
        let first_event = run
            .events
            .recv_timeout(Duration::from_secs(3))
            .expect("receive descriptor-backed started event");
        let terminal = if matches!(first_event, CodexSafeProfileEvent::Started { .. }) {
            run.events
                .recv_timeout(Duration::from_secs(3))
                .expect("receive descriptor-backed terminal event")
        } else {
            first_event
        };

        // Assert
        assert!(
            stale_admission.is_err(),
            "the public receipt path rejects the replaced PATH entry before launch"
        );
        assert!(
            matches!(terminal, CodexSafeProfileEvent::Completed { .. }),
            "the private test helper executes only its descriptor-derived materialization"
        );
        assert_eq!(
            std::fs::read_to_string(&observed_prompt)
                .expect("read descriptor materialization input"),
            "only-the-observed-materialization-may-read-this",
            "stdin is released only after the spawned materialization identity checks"
        );
        assert!(
            !replaced_prompt.exists(),
            "a replacement installed between probe and spawn receives no prompt bytes"
        );

        let _ = std::fs::remove_dir_all(&scratch);
    }

    // Varied, non-repeating trailing comment bytes. Interleaved chunk reads then produce a
    // different digest instead of accidentally agreeing on repeated filler.
    #[cfg(unix)]
    fn varied_executable_padding(byte_budget: usize) -> String {
        let mut padding = String::with_capacity(byte_budget + 32);
        let mut noise = 0x2545_f491_4f6c_dd1d_u64;
        while padding.len() < byte_budget {
            noise = noise
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            padding.push_str(&format!("# {noise:016x}\n"));
        }
        padding
    }

    // The same descriptor bytes for every concurrent run, sized so one materialization spans many
    // 64 KiB chunks. Each invocation writes its stdin to its own file keyed by its shell PID.
    #[cfg(unix)]
    fn write_large_codex_prompt_directory_fixture(
        path: &Path,
        prompt_directory: &Path,
        padding_bytes: usize,
    ) {
        use std::os::unix::fs::PermissionsExt;

        let prompt_directory = shell_single_quote(&prompt_directory.to_string_lossy());
        let script = format!(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  printf '%s\\n' 'codex-cli 0.153.4'\nelif [ \"$1\" = \"--help\" ]; then\n  printf '%s\\n' '--ask-for-approval never -c'\nelif [ \"$1\" = \"exec\" ] && [ \"$2\" = \"--help\" ]; then\n  printf '%s\\n' '--ephemeral --ignore-user-config --ignore-rules --sandbox read-only --json --output-schema --skip-git-repo-check'\nelse\n  /bin/cat > {prompt_directory}/prompt-$$\n  printf '%s\\n' '{{\"type\":\"item.completed\",\"item\":{{\"type\":\"agent_message\",\"text\":\"{{\\\"result\\\":{{\\\"summary\\\":\\\"descriptor complete\\\",\\\"findings\\\":[],\\\"requirementCoverage\\\":null,\\\"reportedModel\\\":null}}}}\"}}}}'\n  exit 0\nfi\n{}",
            varied_executable_padding(padding_bytes)
        );
        std::fs::write(path, script).expect("write large descriptor-backed prompt fixture");
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .expect("make large descriptor-backed prompt fixture executable");
    }

    // One full public-path start: receipt revalidation, run-owned materialization, spawn, and
    // stdin delivery, reported as its first terminal event.
    #[cfg(unix)]
    fn await_receipt_backed_start(
        broker: &CodexSafeProfileBroker,
        request: CodexSafeProfileStartRequest,
        paths: CodexSafeProfileRunPaths,
        verified: VerifiedCodexLaunch,
        cancellation_latch: &Arc<AtomicBool>,
    ) -> Result<CodexSafeProfileEvent, String> {
        let bounded_wait = Duration::from_secs(30);
        let run = start_codex_safe_profile_from_paths(
            broker,
            request,
            bounded_wait,
            verified,
            paths,
            true,
            cancellation_latch,
        )?;
        while let Ok(event) = run.events.recv_timeout(bounded_wait) {
            let is_terminal = matches!(
                event,
                CodexSafeProfileEvent::Completed { .. } | CodexSafeProfileEvent::Failed { .. }
            );
            if is_terminal {
                return Ok(event);
            }
        }

        Err("no terminal event arrived for a concurrent start".into())
    }

    #[cfg(unix)]
    fn materialize_run_owned_executable_digest(
        app_owned_root: &Path,
        verified: &VerifiedCodexLaunch,
        run_id: String,
    ) -> Result<String, String> {
        let request = CodexSafeProfileStartRequest {
            run_id,
            pr_key: "acme/web#42".into(),
            operation: CodexSafeProfileOperation::Review,
            prompt: "bounded materialization fixture".into(),
            model: None,
            provenance_receipt_id: "fixture-receipt".into(),
        };
        let paths = CodexSafeProfileRunPaths::create(app_owned_root, &request)?;
        materialize_verified_codex_executable(&paths, verified)?;
        let materialized = std::fs::File::open(&paths.executable)
            .map_err(|_| "could not re-open a run-owned materialization".to_string())?;

        digest_open_executable(&materialized)
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_descriptor_materialization_uses_positional_reads_without_cross_run_offset_or_identity_mixup(
    ) {
        // Arrange
        let scratch = TestScratchRoot::new("prv-codex-safe-profile-s108-positional");
        let prompt_directory = scratch.join("delivered-prompts");
        std::fs::create_dir_all(&prompt_directory).expect("create positional-read fixture roots");
        let padding_bytes = 4 * 1024 * 1024;
        write_large_codex_prompt_directory_fixture(
            &scratch.join("codex"),
            &prompt_directory,
            padding_bytes,
        );
        let broker = fixture_broker(
            &scratch,
            "--ephemeral --ignore-user-config --ignore-rules --sandbox read-only --json --output-schema --skip-git-repo-check",
        );
        let capability = broker.capability();
        let receipt_id = capability
            .receipt_id
            .clone()
            .expect("the large fixture issues an exact descriptor-bound receipt");
        // Every concurrent reader below shares this one receipt-held descriptor.
        let verified = broker
            .verified_receipt(&receipt_id)
            .expect("broker retains the opaque receipt behind one shared descriptor");
        let expected_content_digest = verified.observed_executable.identity.content_digest.clone();
        let concurrent_starts = 8_usize;
        let concurrent_materializations = 8_usize;
        let materializations_per_thread = 3_usize;
        let concurrent_capability_probes = 8_usize;
        let start_requests: Vec<CodexSafeProfileStartRequest> = (0..concurrent_starts)
            .map(|index| CodexSafeProfileStartRequest {
                run_id: format!("positional-start-{index}"),
                pr_key: "acme/web#42".into(),
                operation: CodexSafeProfileOperation::Review,
                prompt: format!("only-run-{index}-may-read-these-bytes"),
                model: None,
                provenance_receipt_id: receipt_id.clone(),
            })
            .collect();
        let mut expected_prompts: Vec<String> = start_requests
            .iter()
            .map(|request| request.prompt.clone())
            .collect();
        expected_prompts.sort();
        let start_paths: Vec<CodexSafeProfileRunPaths> = start_requests
            .iter()
            .map(|request| {
                CodexSafeProfileRunPaths::create(&scratch, request)
                    .expect("reserve one run root per concurrent start")
            })
            .collect();
        let cancellation_latch = Arc::new(AtomicBool::new(false));
        let gate = std::sync::Barrier::new(
            concurrent_starts + concurrent_materializations + concurrent_capability_probes,
        );
        let start_outcomes: Mutex<Vec<Result<CodexSafeProfileEvent, String>>> =
            Mutex::new(Vec::new());
        let materialized_digests: Mutex<Vec<Result<String, String>>> = Mutex::new(Vec::new());
        let probed_capabilities: Mutex<Vec<CodexSafeProfileCapability>> = Mutex::new(Vec::new());

        // Act
        let shared_gate = &gate;
        let shared_broker = &broker;
        let app_owned_root: &Path = &scratch;
        let recorded_starts = &start_outcomes;
        let recorded_digests = &materialized_digests;
        let recorded_capabilities = &probed_capabilities;
        std::thread::scope(|scope| {
            for (request, paths) in start_requests.into_iter().zip(start_paths) {
                let verified = verified.clone();
                let cancellation_latch = cancellation_latch.clone();
                scope.spawn(move || {
                    shared_gate.wait();
                    let outcome = await_receipt_backed_start(
                        shared_broker,
                        request,
                        paths,
                        verified,
                        &cancellation_latch,
                    );
                    recorded_starts
                        .lock()
                        .expect("record a start outcome")
                        .push(outcome);
                });
            }
            for thread_index in 0..concurrent_materializations {
                let verified = verified.clone();
                scope.spawn(move || {
                    shared_gate.wait();
                    for iteration in 0..materializations_per_thread {
                        let run_id = format!("positional-copy-{thread_index}-{iteration}");
                        let digest = materialize_run_owned_executable_digest(
                            app_owned_root,
                            &verified,
                            run_id,
                        );
                        recorded_digests
                            .lock()
                            .expect("record a materialized digest")
                            .push(digest);
                    }
                });
            }
            for _ in 0..concurrent_capability_probes {
                scope.spawn(move || {
                    shared_gate.wait();
                    let probed = shared_broker.capability();
                    recorded_capabilities
                        .lock()
                        .expect("record a probed capability")
                        .push(probed);
                });
            }
        });
        let mut delivered_prompts: Vec<String> = std::fs::read_dir(&prompt_directory)
            .expect("read the delivered prompt directory")
            .map(|entry| {
                std::fs::read_to_string(entry.expect("read a prompt entry").path())
                    .expect("read delivered prompt bytes")
            })
            .collect();
        delivered_prompts.sort();

        // Assert
        for outcome in start_outcomes.lock().expect("read start outcomes").iter() {
            assert!(
                matches!(outcome, Ok(CodexSafeProfileEvent::Completed { .. })),
                "every concurrent start materializes its own descriptor bytes: {outcome:?}"
            );
        }
        for digest in materialized_digests.lock().expect("read digests").iter() {
            assert_eq!(
                digest.as_deref(),
                Ok(expected_content_digest.as_str()),
                "every concurrent materialization matches its own descriptor content digest"
            );
        }
        for probed in probed_capabilities
            .lock()
            .expect("read capabilities")
            .iter()
        {
            assert!(
                probed.available && probed.receipt_id.is_some(),
                "a concurrent capability probe never reads another reader's interleaved bytes"
            );
        }
        assert_eq!(
            delivered_prompts, expected_prompts,
            "each run delivers only its own prompt, and a mismatched materialization delivers none"
        );

        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[cfg(unix)]
    #[test]
    fn public_capability_accepts_only_exact_0_153_4_descriptor_bound_receipt() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-codex-safe-profile-s96-receipt");
        std::fs::create_dir_all(&scratch).expect("create exact-receipt fixture directory");
        let controls = "--ephemeral --ignore-user-config --ignore-rules --sandbox read-only --json --output-schema --skip-git-repo-check";
        let executable = scratch.join("codex");
        write_codex_compatibility_fixture(
            &executable,
            CODEX_SAFE_PROFILE_EXACT_CLI_VERSION,
            controls,
        );
        let exact_broker = fixture_broker(&scratch, controls);
        let exact_capability = exact_broker.capability();
        let exact_receipt = exact_broker
            .verified_receipt(
                exact_capability
                    .receipt_id
                    .as_deref()
                    .expect("an exact capability issues an opaque receipt"),
            )
            .expect("broker retains its opaque exact receipt");

        // Act
        write_codex_compatibility_fixture(&executable, "0.153.3", controls);
        let older = fixture_broker(&scratch, controls).capability();
        write_codex_compatibility_fixture(&executable, "0.153.5", controls);
        let newer = fixture_broker(&scratch, controls).capability();
        write_codex_compatibility_fixture(
            &executable,
            CODEX_SAFE_PROFILE_EXACT_CLI_VERSION,
            "--ephemeral",
        );
        let changed_help = exact_broker.capability();
        write_codex_compatibility_fixture(
            &executable,
            CODEX_SAFE_PROFILE_EXACT_CLI_VERSION,
            controls,
        );
        std::fs::OpenOptions::new()
            .append(true)
            .open(&executable)
            .expect("open fixture replacement")
            .write_all(b"# replacement without a help change\n")
            .expect("replace descriptor bytes");
        let stale_descriptor = exact_broker.revalidate_verified_launch(&exact_receipt);
        let mut profile_mismatch = exact_receipt;
        profile_mismatch.provenance.safe_profile_revision = "different-profile".into();
        let stale_profile = exact_broker.revalidate_verified_launch(&profile_mismatch);

        // Assert
        assert!(exact_capability.available && exact_capability.diagnostics.is_empty());
        assert!(exact_capability.receipt_id.is_some() && exact_capability.provenance.is_some());
        for rejected in [older, newer, changed_help] {
            assert!(
                !rejected.available
                    && rejected.receipt_id.is_none()
                    && rejected.provenance.is_none(),
                "older, newer, or changed-help executables cannot issue an available receipt"
            );
        }
        assert!(
            stale_descriptor.is_err() && stale_profile.is_err(),
            "descriptor and profile mismatches make the prior opaque receipt unusable before launch"
        );

        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[cfg(unix)]
    #[test]
    fn shutdown_cancels_active_runs_and_startup_marks_owned_running_reviews_interrupted() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-ai-broker-shutdown");
        std::fs::create_dir_all(&scratch).expect("create broker shutdown scratch directory");
        let active_runs = CodexSafeProfileActiveRuns::default();
        let run_id = "shutdown-tree".to_string();
        let request = CodexSafeProfileStartRequest {
            run_id: run_id.clone(),
            pr_key: "acme/web#42".into(),
            operation: CodexSafeProfileOperation::Review,
            prompt: "bounded shutdown fixture".into(),
            model: None,
            provenance_receipt_id: "test-receipt".into(),
        };
        assert_eq!(
            active_runs
                .enqueue(
                    request.clone(),
                    test_queued_paths("preparing-run"),
                    test_verified_launch()
                )
                .expect("admit shutdown fixture"),
            AiBrokerQueueState::Started
        );
        let descendant_pid_file = scratch.join("descendant.pid");
        let broker_run = start_broker_process(
            run_id.clone(),
            crate::ai_broker_test_child::fixture_command(&descendant_pid_file),
            Duration::from_secs(10),
        )
        .expect("start broker shutdown fixture");
        let preparing = active_runs
            .begin_preparing(&run_id)
            .expect("fixture enters preparing before active registration");
        active_runs
            .register_active(&run_id, broker_run.cancellation(), &preparing)
            .expect("register admitted fixture process");
        let _started = wait_for_event(
            &broker_run.events,
            |event| matches!(event, AiBrokerEvent::Started { run_id: event_run_id } if event_run_id == &run_id),
        );
        let _ready = wait_for_event(
            &broker_run.events,
            |event| matches!(event, AiBrokerEvent::Stdout { line, .. } if line == "fixture-ready"),
        );
        let descendant_pid: i32 = std::fs::read_to_string(&descendant_pid_file)
            .expect("read shutdown fixture descendant PID")
            .parse()
            .expect("parse shutdown fixture descendant PID");
        let stale_paths = CodexSafeProfileRunPaths::create(
            &scratch,
            &CodexSafeProfileStartRequest {
                run_id: "stale-owned-run".into(),
                pr_key: "acme/web#42".into(),
                operation: CodexSafeProfileOperation::Review,
                prompt: "stale state".into(),
                model: None,
                provenance_receipt_id: "test-receipt".into(),
            },
        )
        .expect("create owned stale run state");
        let unowned_sibling = scratch.join("codex-safe-profile").join("unowned-run");
        std::fs::create_dir_all(&unowned_sibling).expect("create unowned sibling state");

        // Act
        active_runs
            .shutdown()
            .expect("broker shutdown cleans active runs");
        let safely_resolved_run_ids = recover_codex_safe_profile_transients(&scratch)
            .expect("startup recovery inspects only app-owned state");

        // Assert
        assert!(
            wait_for_process_exit(descendant_pid),
            "normal desktop shutdown must terminate the active provider process tree"
        );
        assert!(
            safely_resolved_run_ids.is_empty(),
            "legacy marker-only state has no PID/start evidence and must remain unresolved"
        );
        assert!(
            stale_paths.root.exists(),
            "startup recovery must refuse marker-only cleanup without liveness evidence"
        );
        assert!(
            unowned_sibling.exists(),
            "startup recovery must not remove an unmarked sibling path"
        );
        let state = active_runs
            .state
            .lock()
            .expect("broker state remains available");
        assert!(state
            .controls
            .values()
            .all(|control| { control.state == CodexSafeProfileAdmissionState::Terminal }));
        assert!(state.queue.active.is_empty());
        drop(state);

        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[cfg(unix)]
    #[test]
    fn startup_recovery_requires_matching_pid_process_start_before_owned_cleanup_or_interruption() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-ai-broker-liveness-recovery");
        std::fs::create_dir_all(&scratch).expect("create liveness recovery scratch directory");
        let request = |run_id: &str| CodexSafeProfileStartRequest {
            run_id: run_id.into(),
            pr_key: "acme/web#42".into(),
            operation: CodexSafeProfileOperation::Review,
            prompt: "bounded liveness fixture".into(),
            model: None,
            provenance_receipt_id: "test-receipt".into(),
        };
        let live_paths = CodexSafeProfileRunPaths::create(&scratch, &request("live-owned-run"))
            .expect("create live marker-owned state");
        let descendant_pid_file = scratch.join("liveness-descendant.pid");
        let broker_run = start_broker_process(
            "live-owned-run".into(),
            crate::ai_broker_test_child::fixture_command(&descendant_pid_file),
            Duration::from_secs(10),
        )
        .expect("start live owned fixture");
        persist_codex_safe_profile_liveness(
            &live_paths,
            "live-owned-run",
            broker_run.cancellation().process_group,
            broker_run.cancellation().process_group,
        )
        .expect("persist PID/start identity before recovery");
        persist_codex_safe_profile_admission(
            &live_paths,
            "live-owned-run",
            CodexSafeProfileAdmissionState::Active,
            &test_verified_launch().provenance,
        )
        .expect("persist active admission evidence before recovery");
        let _ready = wait_for_event(
            &broker_run.events,
            |event| matches!(event, AiBrokerEvent::Stdout { line, .. } if line == "fixture-ready"),
        );
        let descendant_pid: i32 = std::fs::read_to_string(&descendant_pid_file)
            .expect("read live fixture descendant PID")
            .parse()
            .expect("parse live fixture descendant PID");
        let reused_paths = CodexSafeProfileRunPaths::create(&scratch, &request("reused-pid-run"))
            .expect("create PID-reuse marker-owned state");
        let current_pid = i32::try_from(std::process::id()).expect("current PID fits i32");
        let current_identity =
            process_start_identity(current_pid).expect("observe current process identity");
        let reused_record = CodexSafeProfileLivenessRecord {
            run_id: "reused-pid-run".into(),
            process_group: current_pid,
            pid: current_pid,
            process_start_identity: format!("{current_identity}-different-process-instance"),
        };
        std::fs::write(
            reused_paths.root.join(CODEX_SAFE_PROFILE_LIVENESS_RECORD),
            serde_json::to_vec(&reused_record).expect("encode reused PID evidence"),
        )
        .expect("write mismatched PID evidence");
        let unknown_paths = CodexSafeProfileRunPaths::create(&scratch, &request("unknown-pid-run"))
            .expect("create unknown-evidence marker-owned state");
        let unowned_sibling = scratch.join("codex-safe-profile").join("unowned-sibling");
        std::fs::create_dir_all(&unowned_sibling).expect("create unowned sibling");
        let symlink = scratch.join("codex-safe-profile").join("symlinked-run");
        std::os::unix::fs::symlink(&unowned_sibling, &symlink)
            .expect("create unowned symlinked candidate");

        // Act
        let safely_resolved_run_ids = recover_codex_safe_profile_transients(&scratch)
            .expect("recover only identity-safe owned provider state");

        // Assert
        assert_eq!(safely_resolved_run_ids, vec!["live-owned-run"]);
        assert!(
            wait_for_process_exit(descendant_pid),
            "a matching owned provider process must be terminated and reaped before cleanup"
        );
        assert!(
            !live_paths.root.exists(),
            "matching live state is cleaned only after wait"
        );
        assert!(
            reused_paths.root.exists(),
            "a reused PID leaves its marker/state intact"
        );
        assert!(
            unknown_paths.root.exists(),
            "unknown liveness evidence leaves marker/state intact"
        );
        assert!(
            unowned_sibling.exists(),
            "unowned siblings remain untouched"
        );
        assert!(symlink.exists(), "symlinked candidates remain untouched");

        let _ = std::fs::remove_dir_all(&scratch);
    }

    // Broker cleanup, terminalization, and startup recovery all treat "process group absent" as the
    // only permission to delete marker-owned evidence. macOS answers `killpg` with `EPERM` once a
    // group holds nothing but unreaped zombies, so absence has to be observed rather than inferred
    // from that errno, and a still-live member must never be mistaken for a collectable one.
    #[cfg(target_os = "macos")]
    #[test]
    fn zombie_only_process_group_is_observed_absent_while_unreaped_leader_is_never_signalled_live()
    {
        // Arrange
        let mut live_command = Command::new("/bin/sleep");
        live_command.arg("30");
        configure_process_group(&mut live_command);
        let mut live_child = live_command
            .spawn()
            .expect("start a live owned-group fixture");
        let live_process_group =
            i32::try_from(live_child.id()).expect("the live fixture PID fits i32");
        let mut exiting_command = Command::new("/bin/sh");
        exiting_command.args(["-c", "exit 0"]);
        configure_process_group(&mut exiting_command);
        let mut exiting_child = exiting_command
            .spawn()
            .expect("start an immediately exiting owned-group fixture");
        let zombie_process_group =
            i32::try_from(exiting_child.id()).expect("the exiting fixture PID fits i32");
        // Never wait on this child until the assertions are done: an unreaped exited process stays
        // in its own group as the exact state that used to be reported as unobservable.
        let zombie_deadline = Instant::now() + Duration::from_secs(5);
        while darwin_process_is_awaiting_collection(zombie_process_group) != Some(true) {
            assert!(
                Instant::now() < zombie_deadline,
                "the exiting fixture did not reach its awaiting-collection state"
            );
            std::thread::sleep(Duration::from_millis(10));
        }

        // Act
        let live_group_observation = process_group_exists(live_process_group);
        let unreaped_group_observation = process_group_exists(zombie_process_group);
        exiting_child.wait().expect("collect the exited fixture");
        let reaped_group_observation = process_group_exists(zombie_process_group);

        // Assert
        assert_eq!(
            live_group_observation,
            Ok(true),
            "a group holding a live process is still reported present"
        );
        assert_eq!(
            unreaped_group_observation,
            Ok(false),
            "a group holding only an unreaped exited process holds no live process"
        );
        assert_eq!(
            reaped_group_observation,
            Ok(false),
            "collecting the exit status does not change the observed absence"
        );

        let _ = live_child.kill();
        let _ = live_child.wait();
    }

    #[test]
    fn macos_birth_time_identity_rejects_short_or_mutable_proc_records() {
        // Arrange
        let mut record = unsafe { std::mem::zeroed::<DarwinProcBsdInfo>() };
        record.pbi_pid = 42;
        record.pbi_comm[..5].copy_from_slice(b"codex");
        record.pbi_start_tvsec = 1_700_000_000;
        record.pbi_start_tvusec = 123_456;
        let original = unsafe {
            std::slice::from_raw_parts(
                std::ptr::addr_of!(record).cast::<u8>(),
                std::mem::size_of::<DarwinProcBsdInfo>(),
            )
            .to_vec()
        };
        let mut mutable_record = record;
        mutable_record.pbi_status = 99;
        mutable_record.pbi_comm[..5].copy_from_slice(b"other");
        let mutable = unsafe {
            std::slice::from_raw_parts(
                std::ptr::addr_of!(mutable_record).cast::<u8>(),
                std::mem::size_of::<DarwinProcBsdInfo>(),
            )
            .to_vec()
        };

        // Act
        let birth_identity = darwin_birth_identity_from_exact_record(&original);
        let mutable_identity = darwin_birth_identity_from_exact_record(&mutable);
        let short_identity = darwin_birth_identity_from_exact_record(&original[..135]);

        // Assert
        assert_eq!(
            std::mem::size_of::<DarwinProcBsdInfo>(),
            DARWIN_PROC_BSDINFO_SIZE,
            "the Darwin ABI record must retain its exact expected size"
        );
        assert_eq!(
            birth_identity, mutable_identity,
            "mutable proc metadata cannot become a PID identity"
        );
        assert!(
            short_identity.is_none(),
            "a short PROC_PIDTBSDINFO response must fail closed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn dead_leader_with_live_owned_process_group_remains_unresolved_until_group_exit() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-ai-broker-group-recovery");
        std::fs::create_dir_all(&scratch).expect("create group recovery scratch directory");
        let request = CodexSafeProfileStartRequest {
            run_id: "dead-leader-live-group".into(),
            pr_key: "acme/web#42".into(),
            operation: CodexSafeProfileOperation::Review,
            prompt: "bounded liveness fixture".into(),
            model: None,
            provenance_receipt_id: "test-receipt".into(),
        };
        let paths = CodexSafeProfileRunPaths::create(&scratch, &request)
            .expect("create marker-owned group recovery state");
        let descendant_pid_file = scratch.join("owned-group-descendant.pid");
        let mut command =
            crate::ai_broker_test_child::leader_exits_with_owned_group_descendant_fixture_command(
                &descendant_pid_file,
            );
        configure_process_group(&mut command);
        let mut leader = command.spawn().expect("start owned-group leader fixture");
        let leader_pid = i32::try_from(leader.id()).expect("fixture leader PID fits i32");
        let deadline = Instant::now() + Duration::from_secs(1);
        while !descendant_pid_file.exists() {
            assert!(
                Instant::now() < deadline,
                "owned-group descendant did not record its PID"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        persist_codex_safe_profile_liveness(&paths, &request.run_id, leader_pid, leader_pid)
            .expect("persist leader birth and owned process-group identity");
        persist_codex_safe_profile_admission(
            &paths,
            &request.run_id,
            CodexSafeProfileAdmissionState::Active,
            &test_verified_launch().provenance,
        )
        .expect("persist admitted recovery evidence");
        std::fs::write(
            format!("{}.release", descendant_pid_file.display()),
            "release",
        )
        .expect("allow owned-group leader to exit");
        leader.wait().expect("wait for fixture leader exit");
        let descendant_pid: i32 = std::fs::read_to_string(&descendant_pid_file)
            .expect("read owned-group descendant PID")
            .parse()
            .expect("parse owned-group descendant PID");

        // Act
        let unresolved = recover_codex_safe_profile_transients(&scratch)
            .expect("inspect dead-leader state without assuming its group is empty");

        // Assert
        assert!(
            unresolved.is_empty(),
            "a live owned group is not safely resolved"
        );
        assert!(
            paths.root.exists(),
            "marker evidence remains while descendant group lives"
        );
        assert!(
            process_group_exists(leader_pid).expect("inspect owned process group"),
            "leader exit must not be treated as process-group exit"
        );
        assert!(
            !wait_for_process_exit(descendant_pid),
            "recovery must not interrupt a group merely because its leader exited"
        );

        // Act
        cleanup_process_group(leader_pid).expect("terminate owned descendant group after proof");
        let resolved = recover_codex_safe_profile_transients(&scratch)
            .expect("resolve marker only after observed group exit");

        // Assert
        assert_eq!(resolved, vec![request.run_id]);
        assert!(
            !paths.root.exists(),
            "cleanup follows observed group absence"
        );
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[cfg(unix)]
    #[test]
    fn bootstrap_acknowledges_only_durably_interrupted_recovered_runs_before_rust_deletes_evidence()
    {
        // Arrange
        let scratch = TestScratchRoot::new("prv-ai-broker-recovery-acknowledgement");
        std::fs::create_dir_all(&scratch).expect("create acknowledgement scratch directory");
        let provenance = test_verified_launch().provenance;
        let terminal_directory = scratch
            .join("codex-safe-profile")
            .join(CODEX_SAFE_PROFILE_TERMINAL_RECOVERY_DIRECTORY);
        let admitted_receipt_run_id = "admitted-terminal-receipt";
        let unadmitted_receipt_run_id = "unadmitted-terminal-receipt";
        let malformed_receipt_run_id = "malformed-terminal-receipt";
        let interrupted_root_run_id = "admitted-interrupted-root";
        let unknown_run_id = "never-recovered-run";
        write_codex_safe_profile_terminal_receipt(
            &terminal_directory,
            admitted_receipt_run_id,
            &provenance.provenance_fingerprint,
            true,
        )
        .expect("retain an admitted receipt whose run root is already gone");
        write_codex_safe_profile_terminal_receipt(
            &terminal_directory,
            unadmitted_receipt_run_id,
            &provenance.provenance_fingerprint,
            false,
        )
        .expect("retain a pre-admission receipt with nothing local to interrupt");
        let malformed_receipt = terminal_directory.join(malformed_receipt_run_id);
        let malformed_bytes = b"{\"runId\":";
        std::fs::write(&malformed_receipt, malformed_bytes)
            .expect("write malformed recovery evidence");
        let request = CodexSafeProfileStartRequest {
            run_id: interrupted_root_run_id.into(),
            pr_key: "acme/web#42".into(),
            operation: CodexSafeProfileOperation::Review,
            prompt: "bounded acknowledgement fixture".into(),
            model: None,
            provenance_receipt_id: "test-receipt".into(),
        };
        let paths = CodexSafeProfileRunPaths::create(&scratch, &request)
            .expect("create an admitted marker-owned run root");
        let descendant_pid_file = scratch.join("acknowledgement-descendant.pid");
        let mut command =
            crate::ai_broker_test_child::leader_exits_with_owned_group_descendant_fixture_command(
                &descendant_pid_file,
            );
        configure_process_group(&mut command);
        let mut leader = command.spawn().expect("start owned-group leader fixture");
        let leader_pid = i32::try_from(leader.id()).expect("fixture leader PID fits i32");
        let deadline = Instant::now() + Duration::from_secs(1);
        while !descendant_pid_file.exists() {
            assert!(
                Instant::now() < deadline,
                "owned-group descendant did not record its PID"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        persist_codex_safe_profile_liveness(
            &paths,
            interrupted_root_run_id,
            leader_pid,
            leader_pid,
        )
        .expect("persist leader birth and owned process-group identity");
        persist_codex_safe_profile_admission(
            &paths,
            interrupted_root_run_id,
            CodexSafeProfileAdmissionState::Active,
            &provenance,
        )
        .expect("persist admitted recovery evidence");
        std::fs::write(
            format!("{}.release", descendant_pid_file.display()),
            "release",
        )
        .expect("allow owned-group leader to exit");
        leader.wait().expect("wait for fixture leader exit");
        cleanup_process_group(leader_pid).expect("prove the owned process group absent");
        let recovery = CodexSafeProfileStartupRecovery::default();

        // Act
        let mut reported_run_ids =
            recover_codex_safe_profile_transients(&scratch).expect("report recovered Codex runs");
        reported_run_ids.sort();
        recovery.replace_safely_resolved_run_ids(reported_run_ids.clone());

        // Assert
        let expected_reported_run_ids = vec![
            interrupted_root_run_id.to_string(),
            admitted_receipt_run_id.to_string(),
            unadmitted_receipt_run_id.to_string(),
        ];
        assert_eq!(
            reported_run_ids, expected_reported_run_ids,
            "recovery reports admitted retained receipts, cleaned admitted roots, and consumed pre-admission receipts"
        );
        assert!(
            read_codex_safe_profile_terminal_receipt(
                &terminal_directory.join(admitted_receipt_run_id),
                admitted_receipt_run_id
            )
            .is_some_and(|receipt| receipt.admitted),
            "an admitted receipt survives recovery until the webview acknowledges it"
        );
        assert!(
            !terminal_directory.join(unadmitted_receipt_run_id).exists(),
            "a pre-admission receipt has no local running record and is consumed at once"
        );
        assert_eq!(
            std::fs::read(&malformed_receipt).expect("read malformed recovery evidence"),
            malformed_bytes,
            "malformed evidence is never rewritten or deleted"
        );
        assert!(
            !paths.root.exists()
                && read_codex_safe_profile_terminal_receipt(
                    &terminal_directory.join(interrupted_root_run_id),
                    interrupted_root_run_id
                )
                .is_some_and(|receipt| receipt.admitted),
            "an admitted run root is cleaned only after its retained receipt exists"
        );

        // Act
        let acknowledged_run_ids = vec![
            admitted_receipt_run_id.to_string(),
            unknown_run_id.to_string(),
        ];
        acknowledge_codex_safe_profile_recovered_runs(&scratch, &recovery, &acknowledged_run_ids);

        // Assert
        assert!(
            !terminal_directory.join(admitted_receipt_run_id).exists(),
            "a durably interrupted run's receipt is deleted only once the webview acknowledges it"
        );
        assert!(
            !terminal_directory.join(unknown_run_id).exists()
                && terminal_directory.join(interrupted_root_run_id).exists()
                && malformed_receipt.exists(),
            "an unacknowledged or unknown ID changes no app-owned recovery evidence"
        );

        // Act
        let reported_after_acknowledgement = recover_codex_safe_profile_transients(&scratch)
            .expect("report still-unacknowledged Codex runs on the next startup");

        // Assert
        assert_eq!(
            reported_after_acknowledgement,
            vec![interrupted_root_run_id.to_string()],
            "an unacknowledged admitted receipt is reported again so bootstrap can retry"
        );
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[cfg(unix)]
    #[test]
    fn retained_sender_output_limit_and_dead_leader_keep_owned_evidence_until_process_group_absence(
    ) {
        // Arrange
        let scratch = TestScratchRoot::new("prv-ai-broker-s99-terminal-evidence");
        std::fs::create_dir_all(&scratch).expect("create terminal-evidence scratch directory");
        let request = CodexSafeProfileStartRequest {
            run_id: "retained-output-run".into(),
            pr_key: "acme/web#42".into(),
            operation: CodexSafeProfileOperation::Review,
            prompt: "bounded terminal evidence fixture".into(),
            model: None,
            provenance_receipt_id: "test-receipt".into(),
        };
        let paths = CodexSafeProfileRunPaths::create(&scratch, &request)
            .expect("create marker-owned terminal-evidence state");
        let descendant_pid_file = scratch.join("term-resistant-descendant.pid");
        let mut command = crate::ai_broker_test_child::term_resistant_descendant_fixture_command(
            &descendant_pid_file,
        );
        configure_process_group(&mut command);
        let mut leader = command
            .spawn()
            .expect("start TERM-resistant owned-group fixture");
        let leader_pid = i32::try_from(leader.id()).expect("fixture leader PID fits i32");
        let descendant_deadline = Instant::now() + Duration::from_secs(1);
        while !descendant_pid_file.exists() {
            assert!(
                Instant::now() < descendant_deadline,
                "TERM-resistant descendant did not record its PID"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        let descendant_pid: i32 = std::fs::read_to_string(&descendant_pid_file)
            .expect("read TERM-resistant descendant PID")
            .parse()
            .expect("parse TERM-resistant descendant PID");
        persist_codex_safe_profile_liveness(&paths, &request.run_id, leader_pid, leader_pid)
            .expect("persist marker-owned leader/group evidence");
        persist_codex_safe_profile_admission(
            &paths,
            &request.run_id,
            CodexSafeProfileAdmissionState::Active,
            &test_verified_launch().provenance,
        )
        .expect("persist active admission evidence");
        let (raw_events, raw_receiver) = mpsc::channel();
        let run = stream_codex_safe_profile_output(
            request.run_id.clone(),
            request.operation,
            AiBrokerRun {
                events: raw_receiver,
                cancellation: AiBrokerCancellation {
                    process_group: leader_pid,
                    cancelled: Arc::new(AtomicBool::new(false)),
                },
                stdin: Arc::new(Mutex::new(None)),
            },
            paths.clone(),
            Instant::now(),
            test_verified_launch().provenance,
        );
        raw_events
            .send(AiBrokerEvent::Started {
                run_id: request.run_id.clone(),
            })
            .expect("send public started event");
        raw_events
            .send(AiBrokerEvent::OutputLimitExceeded {
                run_id: request.run_id.clone(),
            })
            .expect("send retained-sender output-limit event");

        // Act
        let started = run
            .events
            .recv_timeout(Duration::from_secs(1))
            .expect("receive public started event");
        let terminal_started_at = Instant::now();
        let terminal = run
            .events
            .recv_timeout(Duration::from_secs(1))
            .expect("receive public output-limit terminal without pipe-drain wait");

        // Assert
        assert!(matches!(started, CodexSafeProfileEvent::Started { .. }));
        assert!(matches!(
            terminal,
            CodexSafeProfileEvent::Failed { ref code, .. } if code == "invalid-output"
        ));
        assert!(
            terminal_started_at.elapsed() < PROCESS_TERMINATION_GRACE,
            "the retained sender cannot delay the public output-limit terminal"
        );
        assert!(
            paths.root.exists()
                && paths.root.join(CODEX_SAFE_PROFILE_LIVENESS_RECORD).exists()
                && scratch
                    .join("codex-safe-profile")
                    .join(CODEX_SAFE_PROFILE_TERMINAL_RECOVERY_DIRECTORY)
                    .join(&request.run_id)
                    .exists(),
            "marker, liveness, and terminal recovery evidence survive until group absence"
        );
        assert!(
            process_group_exists(leader_pid).expect("inspect still-owned process group"),
            "the TERM-resistant descendant retains the group while the public terminal returns"
        );

        drop(raw_events);
        // Bounded terminalization TERM/KILLs the owned group and only then observes it. The run root
        // may be removed once that observation shows the group holds no live process, and never on
        // the strength of a dead leader alone.
        let cleanup_deadline = Instant::now() + Duration::from_secs(3);
        while paths.root.exists() && Instant::now() < cleanup_deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let run_root_removed = !paths.root.exists();
        let owned_group_observation = process_group_exists(leader_pid);
        let _ = leader.wait();
        assert_eq!(
            owned_group_observation,
            Ok(false),
            "the owned process group holds no live process once bounded cleanup has run"
        );
        assert!(
            run_root_removed,
            "the run root is removed only after that group-absence observation"
        );
        assert!(
            wait_for_process_exit(descendant_pid),
            "bounded terminalization cleans the owned TERM-resistant descendant"
        );
        // The retained terminal receipt outlives the run root, so an admitted interruption is still
        // reported to bootstrap and kept until it is acknowledged.
        let recovered = recover_codex_safe_profile_transients(&scratch)
            .expect("independently observe group absence before resolving terminal evidence");
        assert_eq!(recovered, vec![request.run_id]);
        assert!(
            !paths.root.exists(),
            "startup recovery deletes owned evidence only after its group-absence observation"
        );

        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn camel_case_wire_events_and_cancel_request_round_trip() {
        // Arrange
        let start_request = serde_json::json!({
            "runId": "wire-run",
            "prKey": "acme/web#42",
            "operation": "review",
            "prompt": "bounded app-owned prompt",
            "model": null,
            "provenanceReceiptId": "test-receipt"
        });
        let cancel_request = serde_json::json!({ "runId": "wire-run" });
        let event = CodexSafeProfileEvent::Queued {
            run_id: "wire-run".into(),
        };

        // Act
        let parsed_start = serde_json::from_value::<CodexSafeProfileStartRequest>(start_request)
            .expect("camelCase start payload parses");
        let parsed_cancel = serde_json::from_value::<CodexSafeProfileCancelRequest>(cancel_request)
            .expect("camelCase cancel payload parses");
        let serialized_event = serde_json::to_value(event).expect("event serializes");

        // Assert
        assert_eq!(parsed_start.run_id, "wire-run");
        assert_eq!(parsed_start.pr_key, "acme/web#42");
        assert_eq!(parsed_cancel.run_id, "wire-run");
        assert_eq!(serialized_event["type"], "queued");
        assert_eq!(serialized_event["runId"], "wire-run");
        assert!(serialized_event.get("run_id").is_none());
    }

    #[test]
    fn public_fifo_dequeue_to_preparing_is_atomic_and_cancellation_latch_blocks_every_prestdin_boundary(
    ) {
        // Arrange
        let active_runs = CodexSafeProfileActiveRuns::default();
        let request = CodexSafeProfileStartRequest {
            run_id: "preparing-run".into(),
            pr_key: "acme/web#42".into(),
            operation: CodexSafeProfileOperation::Review,
            prompt: "bounded app-owned prompt".into(),
            model: None,
            provenance_receipt_id: "test-receipt".into(),
        };
        active_runs
            .enqueue(
                request,
                test_queued_paths("preparing-run"),
                test_verified_launch(),
            )
            .expect("first run reserves its broker queue slot");
        let preparing = active_runs
            .begin_preparing("preparing-run")
            .expect("reserved slot enters cancellable preparing before launch");

        // Act
        let cancelled_without_child = active_runs
            .cancel("preparing-run")
            .expect("preparing cancellation latches atomically");
        let registration = active_runs.register_active(
            "preparing-run",
            AiBrokerCancellation {
                process_group: 0,
                cancelled: Arc::new(AtomicBool::new(false)),
            },
            &preparing,
        );

        // Assert
        assert!(
            cancelled_without_child,
            "preparing work has no child to signal"
        );
        assert!(
            preparing.load(Ordering::SeqCst),
            "cancellation remains latched for launch"
        );
        assert!(
            registration.is_err(),
            "a cancelled preparation cannot become active"
        );
        let state = active_runs.state.lock().expect("state remains available");
        assert!(
            state
                .controls
                .get("preparing-run")
                .is_some_and(|control| control.state != CodexSafeProfileAdmissionState::Active),
            "the dequeue/register race cannot create an active child handle"
        );
    }

    #[cfg(unix)]
    #[test]
    fn durable_admission_write_failure_emits_one_public_failure_without_active_or_cleanup_race() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-codex-safe-profile-admission-write");
        std::fs::create_dir_all(&scratch).expect("create admission-write fixture directory");
        let executable = scratch.join("codex");
        let observed_prompt = scratch.join("unexpected-prompt");
        write_codex_prompt_fixture(&executable, &observed_prompt);
        let controls = "--ephemeral --ignore-user-config --ignore-rules --sandbox read-only --json --output-schema --skip-git-repo-check";
        let broker = fixture_broker(&scratch, controls);
        let verified_launch = broker
            .probe_verified_launch()
            .expect("fixture has an exact descriptor-bound receipt");
        let active_runs = CodexSafeProfileActiveRuns {
            state: Mutex::new(CodexSafeProfileRunState {
                queue: AiBrokerQueue::new(1, 1).expect("valid FIFO limits"),
                controls: HashMap::new(),
                published_terminals: VecDeque::new(),
                shutting_down: false,
            }),
        };
        let request = CodexSafeProfileStartRequest {
            run_id: "admission-write-failure".into(),
            pr_key: "acme/web#42".into(),
            operation: CodexSafeProfileOperation::Review,
            prompt: "this prompt must remain undisclosed".into(),
            model: None,
            provenance_receipt_id: "fixture-receipt".into(),
        };
        let queued_request = CodexSafeProfileStartRequest {
            run_id: "released-after-admission-failure".into(),
            pr_key: "acme/api#7".into(),
            operation: CodexSafeProfileOperation::Review,
            prompt: "next FIFO prompt".into(),
            model: None,
            provenance_receipt_id: "fixture-receipt".into(),
        };
        let paths = CodexSafeProfileRunPaths::create(&scratch, &request)
            .expect("reserve marker-owned failed-admission root");
        let queued_paths = CodexSafeProfileRunPaths::create(&scratch, &queued_request)
            .expect("reserve marker-owned queued root");
        assert_eq!(
            active_runs
                .enqueue(request.clone(), paths.clone(), verified_launch.clone())
                .expect("first request enters public FIFO"),
            AiBrokerQueueState::Started
        );
        assert_eq!(
            active_runs
                .enqueue(
                    queued_request.clone(),
                    queued_paths,
                    verified_launch.clone()
                )
                .expect("second request queues behind the first"),
            AiBrokerQueueState::Queued
        );
        let preparing = active_runs
            .begin_preparing(&request.run_id)
            .expect("first request is in public preparing state");
        FAIL_NEXT_DURABLE_ADMISSION_WRITE.with(|fail| fail.set(true));

        // Act
        let launch = start_codex_safe_profile(
            &broker,
            request.clone(),
            paths.clone(),
            verified_launch,
            &preparing,
        );
        let error = match launch {
            Err(error) => error,
            Ok(_) => panic!("injected active admission write rejects the public launch"),
        };
        let next = active_runs
            .fail_preparing_and_release(&request.run_id)
            .expect("failed preparing control atomically releases its FIFO slot");

        // Assert
        assert_eq!(
            codex_safe_profile_launch_failure_code(&error),
            "admission-unavailable",
            "the public launcher emits exactly its sanitized pre-admission failure code"
        );
        assert_eq!(
            std::fs::read_to_string(&observed_prompt).unwrap_or_default(),
            "",
            "failed durable admission closes stdin before the fixture can receive a prompt"
        );
        assert!(
            !paths.root.exists()
                || (paths.root.join(CODEX_SAFE_PROFILE_LIVENESS_RECORD).exists()
                    && paths
                        .root
                        .join(CODEX_SAFE_PROFILE_ADMISSION_RECORD)
                        .exists()),
            "cleanup either proves group absence and removes the root, or retains marker-owned liveness evidence"
        );
        let state = active_runs
            .state
            .lock()
            .expect("inspect Rust-owned control state");
        assert!(
            !state.controls.contains_key(&request.run_id),
            "failed evidence never produces an active local admission, and the settled control is dropped rather than retained"
        );
        assert_eq!(
            next.map(|next| next.request.run_id),
            Some(queued_request.run_id),
            "the next FIFO request is released exactly once after terminal cleanup"
        );
        drop(state);
        let _ = std::fs::remove_dir_all(&scratch);
    }

    // `launch_admitted_codex_safe_profile_run`, `codex_safe_profile_start`, and
    // `codex_safe_profile_cancel` all take a `tauri::AppHandle`, which cannot be built in-process.
    // The three helpers below reproduce those bodies with only the `app.emit` transport replaced by
    // this recorder, so the queue, receipt, launch, event-channel, storage, and release seams the
    // scenario drives are the production ones rather than private helpers.
    // What the webview would have received: one label per published event, plus the terminal events
    // themselves so a caller can validate their bounded payloads.
    #[cfg(unix)]
    #[derive(Default)]
    struct PublicCodexSafeProfileEventLog {
        labels: Vec<(String, String)>,
        terminals: Vec<CodexSafeProfileEvent>,
    }

    #[cfg(unix)]
    fn sanitized_terminal_class(event: &CodexSafeProfileEvent) -> &str {
        match event {
            CodexSafeProfileEvent::Completed { .. } => "completed-invalid-contract",
            CodexSafeProfileEvent::Failed { code, .. } => code,
            _ => "non-terminal",
        }
    }

    #[cfg(unix)]
    fn record_public_codex_safe_profile_event(
        published: &mut PublicCodexSafeProfileEventLog,
        event: &CodexSafeProfileEvent,
    ) {
        let (run_id, label) = match event {
            CodexSafeProfileEvent::Queued { run_id } => (run_id, "queued".to_string()),
            CodexSafeProfileEvent::Admitted { run_id, .. } => (run_id, "admitted".to_string()),
            CodexSafeProfileEvent::Started { run_id, .. } => (run_id, "started".to_string()),
            CodexSafeProfileEvent::Progress { run_id } => (run_id, "progress".to_string()),
            CodexSafeProfileEvent::Completed { run_id, .. } => (run_id, "completed".to_string()),
            CodexSafeProfileEvent::Failed { run_id, code, .. } => {
                (run_id, format!("failed:{code}"))
            }
        };
        // A bounded-output overflow publishes one progress event per accepted JSONL line. Folding
        // an immediate repeat keeps each run's recorded sequence exact and still readable.
        let repeats_progress = label == "progress"
            && published
                .labels
                .last()
                .is_some_and(|(last_run_id, last_label)| {
                    last_run_id == run_id && last_label == "progress"
                });
        if repeats_progress {
            return;
        }
        if matches!(
            event,
            CodexSafeProfileEvent::Completed { .. } | CodexSafeProfileEvent::Failed { .. }
        ) {
            published.terminals.push(event.clone());
        }
        published.labels.push((run_id.clone(), label));
    }

    #[cfg(unix)]
    fn public_codex_safe_profile_start(
        broker: &CodexSafeProfileBroker,
        active_runs: &CodexSafeProfileActiveRuns,
        app_owned_root: &Path,
        request: CodexSafeProfileStartRequest,
        published: &mut PublicCodexSafeProfileEventLog,
    ) -> Result<(AiBrokerQueueState, QueuedCodexSafeProfileRun), String> {
        request.validate()?;
        let verified_launch = broker.verified_receipt(&request.provenance_receipt_id)?;
        let paths = CodexSafeProfileRunPaths::create(app_owned_root, &request)?;
        if let Err(error) = persist_codex_safe_profile_admission(
            &paths,
            &request.run_id,
            CodexSafeProfileAdmissionState::Queued,
            &verified_launch.provenance,
        ) {
            cleanup_codex_safe_profile_paths(&paths);
            return Err(error);
        }
        let queue_state =
            match active_runs.enqueue(request.clone(), paths.clone(), verified_launch.clone()) {
                Ok(queue_state) => queue_state,
                Err(error) => {
                    cleanup_codex_safe_profile_paths(&paths);
                    return Err(error);
                }
            };
        if queue_state == AiBrokerQueueState::Queued {
            record_public_codex_safe_profile_event(
                published,
                &CodexSafeProfileEvent::Queued {
                    run_id: request.run_id.clone(),
                },
            );
        }

        Ok((
            queue_state,
            QueuedCodexSafeProfileRun {
                request,
                paths,
                verified_launch,
            },
        ))
    }

    #[cfg(unix)]
    fn public_codex_safe_profile_cancel(
        active_runs: &CodexSafeProfileActiveRuns,
        run_id: &str,
        published: &mut PublicCodexSafeProfileEventLog,
    ) -> Result<(), String> {
        if active_runs.cancel(run_id)? {
            record_public_codex_safe_profile_event(
                published,
                &CodexSafeProfileEvent::Failed {
                    run_id: run_id.to_string(),
                    code: "cancelled".into(),
                    provenance: None,
                },
            );
        }

        Ok(())
    }

    // `on_admitted` runs at the exact boundary where production emits its `admitted` event, so a
    // caller can observe what durable evidence already existed at that moment.
    #[cfg(unix)]
    fn drive_admitted_codex_safe_profile_run(
        broker: &CodexSafeProfileBroker,
        active_runs: &CodexSafeProfileActiveRuns,
        admitted: QueuedCodexSafeProfileRun,
        published: &mut PublicCodexSafeProfileEventLog,
        observed_process_groups: &mut HashMap<String, i32>,
        on_admitted: impl FnOnce(&str),
    ) -> Option<QueuedCodexSafeProfileRun> {
        let run_id = admitted.request.run_id.clone();
        let launch_provenance = admitted.verified_launch.provenance.clone();
        let preparing = active_runs.begin_preparing(&run_id).ok()?;
        if preparing.load(Ordering::SeqCst) {
            if active_runs.claim_terminal_publication(&run_id) {
                record_public_codex_safe_profile_event(
                    published,
                    &CodexSafeProfileEvent::Failed {
                        run_id: run_id.clone(),
                        code: "cancelled".into(),
                        provenance: Some(launch_provenance),
                    },
                );
            }
            return active_runs.release(&run_id).ok().flatten();
        }
        let run = match start_codex_safe_profile(
            broker,
            admitted.request,
            admitted.paths,
            admitted.verified_launch,
            &preparing,
        ) {
            Ok(run) => run,
            Err(error) => {
                let code = codex_safe_profile_launch_failure_code(&error);
                let next = active_runs
                    .fail_preparing_and_release(&run_id)
                    .ok()
                    .flatten();
                if active_runs.claim_terminal_publication(&run_id) {
                    record_public_codex_safe_profile_event(
                        published,
                        &CodexSafeProfileEvent::Failed {
                            run_id: run_id.clone(),
                            code: code.into(),
                            provenance: Some(launch_provenance),
                        },
                    );
                }
                return next;
            }
        };
        observed_process_groups.insert(run_id.clone(), run.cancellation.process_group);
        if preparing.load(Ordering::SeqCst)
            || active_runs
                .register_active(&run_id, run.cancellation.clone(), &preparing)
                .is_err()
        {
            run.cancellation.cancelled.store(true, Ordering::SeqCst);
            let _ = cleanup_process_group(run.cancellation.process_group);
            return active_runs.release(&run_id).ok().flatten();
        }
        on_admitted(&run_id);
        record_public_codex_safe_profile_event(
            published,
            &CodexSafeProfileEvent::Admitted {
                run_id: run_id.clone(),
                provenance: launch_provenance,
            },
        );
        // Per event, not per run. It has to outlast a real provider's thinking time between JSONL
        // frames while still surfacing a genuine stall well before the broker's own run timeout.
        let bounded_event_wait = Duration::from_secs(120);
        while let Ok(event) = run.events.recv_timeout(bounded_event_wait) {
            let terminal = matches!(
                event,
                CodexSafeProfileEvent::Completed { .. } | CodexSafeProfileEvent::Failed { .. }
            );
            record_public_codex_safe_profile_event(published, &event);
            if terminal {
                break;
            }
        }

        active_runs.release(&run_id).ok().flatten()
    }

    #[cfg(unix)]
    fn sorted_directory_entry_names(directory: &Path) -> Vec<String> {
        let mut names = std::fs::read_dir(directory)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .filter(|name| !name.starts_with('.'))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    // The production stream thread terminalizes after publishing its terminal event, so a startup
    // recovery started immediately can walk a run root that is still being removed and report the
    // run in neither its receipt nor its root scan. Waiting for the completed run's owned root to
    // disappear makes the recovery observation below deterministic.
    #[cfg(unix)]
    fn wait_for_run_root_removal(root: &Path) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while root.exists() {
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        true
    }

    #[cfg(unix)]
    fn sorted_delivered_prompts(prompt_directory: &Path) -> Vec<String> {
        let mut prompts = std::fs::read_dir(prompt_directory)
            .map(|entries| {
                entries
                    .flatten()
                    .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
                    .filter(|prompt| !prompt.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        prompts.sort();
        prompts
    }

    // One FIFO-ordered scenario over the production queue: a retained-sender output overflow, a
    // descriptor replaced between receipt issue and start, a consent-revocation-style cancellation
    // while queued and while preparing, an injected durable-admission write failure, and a normal
    // completion. Each failure must publish exactly one public terminal, release exactly one next
    // request, and leave app-owned recovery evidence that startup recovery and acknowledgement
    // resolve without losing anything still unresolved.
    #[cfg(unix)]
    #[test]
    fn public_safe_profile_failures_release_fifo_without_stale_storage_or_recovery_loss() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-codex-safe-profile-public-failures");
        std::fs::create_dir_all(&scratch).expect("create the public-failure scenario directory");
        let fixture_executable = scratch.join("codex");
        let prompt_directory = scratch.join("delivered-prompts");
        let holder_ready_file = scratch.join("retained-sender-holder.ready");
        write_codex_output_limit_fixture(
            &fixture_executable,
            &prompt_directory,
            &holder_ready_file,
        );
        // A byte-different but otherwise compatible executable. Installing it between receipt issue
        // and start must fail revalidation, and its own prompt sink proves it received no stdin.
        let replacement_executable = scratch.join("replacement-codex");
        let stashed_executable = scratch.join("codex-stashed");
        let replacement_prompt = scratch.join("replacement-prompt");
        write_codex_prompt_fixture(&replacement_executable, &replacement_prompt);
        let broker = fixture_broker(&scratch, CODEX_FIXTURE_EXEC_HELP);
        let capability = broker.capability();
        let receipt_id = capability
            .receipt_id
            .clone()
            .expect("the exact fixture descriptor yields a public capability receipt");
        // Production limits: two global process trees and one per PR. One shared PR key therefore
        // makes the whole scenario a single observable FIFO chain.
        let active_runs = CodexSafeProfileActiveRuns::default();
        let pr_key = "acme/web#42";
        let review_request =
            |run_id: &str, prompt: &str, model: Option<&str>| CodexSafeProfileStartRequest {
                run_id: run_id.into(),
                pr_key: pr_key.into(),
                operation: CodexSafeProfileOperation::Review,
                prompt: prompt.into(),
                model: model.map(str::to_string),
                provenance_receipt_id: receipt_id.clone(),
            };
        let overflow_run_id = "overflow-run";
        let replaced_run_id = "replaced-descriptor-run";
        let cancelled_preparing_run_id = "cancelled-preparing-run";
        let admission_failure_run_id = "admission-failure-run";
        let cancelled_queued_run_id = "cancelled-queued-run";
        let completing_run_id = "completing-run";
        let overflow_prompt = "overflow-fixture-prompt";
        let replaced_prompt = "replaced-descriptor-prompt";
        let cancelled_preparing_prompt = "cancelled-preparing-prompt";
        let admission_failure_prompt = "admission-failure-prompt";
        let cancelled_queued_prompt = "cancelled-queued-prompt";
        let completing_prompt = "completing-fixture-prompt";
        let profile_root = scratch.join("codex-safe-profile");
        let terminal_directory = profile_root.join(CODEX_SAFE_PROFILE_TERMINAL_RECOVERY_DIRECTORY);
        let run_root = |run_id: &str| profile_root.join(run_id);
        let mut published = PublicCodexSafeProfileEventLog::default();
        let mut observed_process_groups: HashMap<String, i32> = HashMap::new();
        let (overflow_queue_state, overflow_admitted) = public_codex_safe_profile_start(
            &broker,
            &active_runs,
            &scratch,
            review_request(overflow_run_id, overflow_prompt, Some("overflow")),
            &mut published,
        )
        .expect("the first receipt-backed request enters the public FIFO");
        assert_eq!(
            overflow_queue_state,
            AiBrokerQueueState::Started,
            "the first request is admitted immediately"
        );
        for (run_id, prompt) in [
            (replaced_run_id, replaced_prompt),
            (cancelled_preparing_run_id, cancelled_preparing_prompt),
            (admission_failure_run_id, admission_failure_prompt),
            (cancelled_queued_run_id, cancelled_queued_prompt),
            (completing_run_id, completing_prompt),
        ] {
            let (queue_state, _) = public_codex_safe_profile_start(
                &broker,
                &active_runs,
                &scratch,
                review_request(run_id, prompt, None),
                &mut published,
            )
            .unwrap_or_else(|error| panic!("{run_id} queues behind the active request: {error}"));
            assert_eq!(
                queue_state,
                AiBrokerQueueState::Queued,
                "one active tree per PR keeps {run_id} pending"
            );
        }

        // Act
        // Revoking consent for still-pending work cancels it where it stands, so the FIFO release
        // below must skip it rather than hand it a slot.
        public_codex_safe_profile_cancel(&active_runs, cancelled_queued_run_id, &mut published)
            .expect("a queued request is cancellable through the public command");
        // Production launches an admitted request inside `codex_safe_profile_start` and chains the
        // next one from its event thread. Driving that chain here keeps one FIFO order observable.
        let mut released_order: Vec<String> = Vec::new();
        let mut next = Some(overflow_admitted);

        let overflow = next.take().expect("the first request is admitted");
        released_order.push(overflow.request.run_id.clone());
        next = drive_admitted_codex_safe_profile_run(
            &broker,
            &active_runs,
            overflow,
            &mut published,
            &mut observed_process_groups,
            |_| {},
        );
        let overflow_process_group = *observed_process_groups
            .get(overflow_run_id)
            .expect("the overflow run reports its owned process group");
        let overflow_group_absence_observed =
            matches!(process_group_exists(overflow_process_group), Ok(false));
        let overflow_evidence_retained = run_root(overflow_run_id).exists()
            && run_root(overflow_run_id)
                .join(CODEX_SAFE_PROFILE_LIVENESS_RECORD)
                .exists()
            && terminal_directory.join(overflow_run_id).exists();

        // Replacing the resolved PATH entry after its receipt was issued must fail closed before
        // any run-owned materialization, spawn, or stdin disclosure.
        std::fs::rename(&fixture_executable, &stashed_executable)
            .expect("stash the receipt-bound descriptor");
        std::fs::rename(&replacement_executable, &fixture_executable)
            .expect("install the replacement descriptor");
        let replaced = next
            .take()
            .expect("the overflow terminal releases the next FIFO request");
        released_order.push(replaced.request.run_id.clone());
        next = drive_admitted_codex_safe_profile_run(
            &broker,
            &active_runs,
            replaced,
            &mut published,
            &mut observed_process_groups,
            |_| {},
        );
        let replaced_materialization_exists =
            run_root(replaced_run_id).join("codex-verified").exists();
        // `rename` preserves the inode and birth time, so restoring the stash restores the exact
        // identity the receipt was issued for.
        std::fs::rename(&fixture_executable, &replacement_executable)
            .expect("remove the replacement descriptor");
        std::fs::rename(&stashed_executable, &fixture_executable)
            .expect("restore the receipt-bound descriptor");

        let cancelled_preparing = next
            .take()
            .expect("the rejected descriptor releases the next FIFO request");
        released_order.push(cancelled_preparing.request.run_id.clone());
        public_codex_safe_profile_cancel(&active_runs, cancelled_preparing_run_id, &mut published)
            .expect("a preparing request is cancellable through the public command");
        // A reviewer can revoke consent twice. The second cancellation latches the same preparing
        // control again and must publish nothing.
        public_codex_safe_profile_cancel(&active_runs, cancelled_preparing_run_id, &mut published)
            .expect("a repeated cancellation of preparing work stays accepted");
        next = drive_admitted_codex_safe_profile_run(
            &broker,
            &active_runs,
            cancelled_preparing,
            &mut published,
            &mut observed_process_groups,
            |_| {},
        );
        let cancelled_preparing_spawned =
            observed_process_groups.contains_key(cancelled_preparing_run_id);

        let admission_failure = next
            .take()
            .expect("the cancelled preparation releases the next FIFO request");
        released_order.push(admission_failure.request.run_id.clone());
        FAIL_NEXT_DURABLE_ADMISSION_WRITE.with(|fail| fail.set(true));
        next = drive_admitted_codex_safe_profile_run(
            &broker,
            &active_runs,
            admission_failure,
            &mut published,
            &mut observed_process_groups,
            |_| {},
        );

        let completing = next
            .take()
            .expect("the failed admission releases the next FIFO request");
        released_order.push(completing.request.run_id.clone());
        next = drive_admitted_codex_safe_profile_run(
            &broker,
            &active_runs,
            completing,
            &mut published,
            &mut observed_process_groups,
            |_| {},
        );
        let queue_drained = next.is_none();
        let completing_root_removed = wait_for_run_root_removal(&run_root(completing_run_id));
        // The overflow run's bounded terminalization TERM/KILLs its retained-sender holder and only
        // then observes the owned group. Waiting for that observation to land keeps the recovery
        // expectations below independent of how long the holder resisted.
        let overflow_root_removed = wait_for_run_root_removal(&run_root(overflow_run_id));
        let delivered_prompts = sorted_delivered_prompts(&prompt_directory);

        let recovery = CodexSafeProfileStartupRecovery::default();
        let mut first_recovery_run_ids = recover_codex_safe_profile_transients(&scratch)
            .expect("startup recovery inspects only app-owned state");
        first_recovery_run_ids.sort();
        recovery.replace_safely_resolved_run_ids(first_recovery_run_ids.clone());
        let roots_after_recovery = sorted_directory_entry_names(&profile_root)
            .into_iter()
            .filter(|name| name != CODEX_SAFE_PROFILE_TERMINAL_RECOVERY_DIRECTORY)
            .collect::<Vec<_>>();
        let acknowledged_run_ids = vec![
            admission_failure_run_id.to_string(),
            completing_run_id.to_string(),
            "never-recovered-run".to_string(),
        ];
        acknowledge_codex_safe_profile_recovered_runs(&scratch, &recovery, &acknowledged_run_ids);
        let receipts_after_acknowledgement = sorted_directory_entry_names(&terminal_directory);
        let second_recovery_run_ids = recover_codex_safe_profile_transients(&scratch)
            .expect("a later startup recovery reports only still-unresolved evidence");

        // Assert
        let published_events = |run_id: &str| {
            published
                .labels
                .iter()
                .filter(|(event_run_id, _)| event_run_id == run_id)
                .map(|(_, label)| label.as_str())
                .collect::<Vec<_>>()
        };
        assert!(
            capability.available && capability.core_controls_verified,
            "the exact fixture descriptor is publicly available"
        );
        assert_eq!(
            released_order,
            vec![
                overflow_run_id,
                replaced_run_id,
                cancelled_preparing_run_id,
                admission_failure_run_id,
                completing_run_id,
            ],
            "every terminal releases exactly the next FIFO request, skipping cancelled pending work"
        );
        assert!(
            queue_drained,
            "the last terminal leaves no admitted or pending request behind"
        );
        assert_eq!(
            published_events(overflow_run_id),
            vec!["admitted", "started", "progress", "failed:invalid-output"],
            "a retained-sender output overflow publishes exactly one invalid-output terminal"
        );
        assert!(
            !overflow_group_absence_observed && overflow_evidence_retained,
            "the overflow run keeps its marker, liveness, and terminal receipt while its owned process group absence is unproven"
        );
        assert_eq!(
            published_events(replaced_run_id),
            vec!["queued", "failed:process-failed"],
            "a replaced descriptor publishes exactly one pre-launch failure"
        );
        assert!(
            !replaced_materialization_exists && !replacement_prompt.exists(),
            "a replaced descriptor is rejected before materialization, spawn, and stdin disclosure"
        );
        assert_eq!(
            published_events(cancelled_preparing_run_id),
            vec!["queued", "failed:cancelled"],
            "cancelling preparing work publishes exactly one cancelled terminal"
        );
        assert!(
            !cancelled_preparing_spawned,
            "cancelled preparation never reaches a spawned child"
        );
        assert_eq!(
            published_events(cancelled_queued_run_id),
            vec!["queued", "failed:cancelled"],
            "cancelling queued work publishes exactly one cancelled terminal"
        );
        assert_eq!(
            published_events(admission_failure_run_id),
            vec!["queued", "failed:admission-unavailable"],
            "a failed durable admission publishes exactly one admission-unavailable terminal"
        );
        assert_eq!(
            published_events(completing_run_id),
            vec!["queued", "admitted", "started", "completed"],
            "the released tail of the FIFO chain still completes through the public stream"
        );
        assert!(
            completing_root_removed,
            "a completed run proves its owned process group absent and removes its run root"
        );
        assert_eq!(
            delivered_prompts,
            vec![completing_prompt, overflow_prompt],
            "only the two admitted runs ever received prompt bytes"
        );
        assert_eq!(
            first_recovery_run_ids,
            vec![
                admission_failure_run_id,
                cancelled_preparing_run_id,
                cancelled_queued_run_id,
                completing_run_id,
                overflow_run_id,
                replaced_run_id,
            ],
            "startup recovery resolves every run whose owned process group it could observe absent"
        );
        assert!(
            overflow_root_removed && roots_after_recovery.is_empty(),
            "a run root is removed only once its owned process group is observed to hold no live process"
        );
        assert_eq!(
            receipts_after_acknowledgement,
            vec![overflow_run_id],
            "acknowledgement deletes only acknowledged receipts and never unresolved evidence"
        );
        assert_eq!(
            second_recovery_run_ids,
            vec![overflow_run_id],
            "an unacknowledged admitted receipt is reported again so bootstrap can retry it"
        );

        let _ = active_runs.shutdown();
        let _ = std::fs::remove_dir_all(&scratch);
    }

    // A control carries the run's full prompt (up to 512 KiB), its reserved run paths, and an open
    // descriptor for the verified executable. Once the run has settled and its terminal is
    // published, none of that may stay resident for the rest of the app's lifetime.
    #[cfg(unix)]
    #[test]
    fn terminal_control_release_retains_no_prompt_bytes_or_control_entry() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-codex-safe-profile-control-retention");
        std::fs::create_dir_all(&scratch).expect("create the control-retention fixture directory");
        write_codex_output_limit_fixture(
            &scratch.join("codex"),
            &scratch.join("prompts"),
            &scratch.join("term-resistant-holder.ready"),
        );
        let broker = fixture_broker(&scratch, CODEX_FIXTURE_EXEC_HELP);
        let receipt_id = broker
            .capability()
            .receipt_id
            .expect("the exact fixture descriptor yields a public capability receipt");
        let active_runs = CodexSafeProfileActiveRuns::default();
        let settling_prompt = "settling-run-prompt-that-must-not-stay-resident";
        let pending_prompt = "pending-run-prompt-that-is-still-needed";
        let review_request = |run_id: &str, prompt: &str| CodexSafeProfileStartRequest {
            run_id: run_id.into(),
            pr_key: "acme/web#42".into(),
            operation: CodexSafeProfileOperation::Review,
            prompt: prompt.into(),
            model: None,
            provenance_receipt_id: receipt_id.clone(),
        };
        let mut published = PublicCodexSafeProfileEventLog::default();
        let mut observed_process_groups: HashMap<String, i32> = HashMap::new();
        let (_, settling) = public_codex_safe_profile_start(
            &broker,
            &active_runs,
            &scratch,
            review_request("settling-run", settling_prompt),
            &mut published,
        )
        .expect("the first receipt-backed request is admitted");
        public_codex_safe_profile_start(
            &broker,
            &active_runs,
            &scratch,
            review_request("pending-run", pending_prompt),
            &mut published,
        )
        .expect("the second receipt-backed request queues behind it");

        // Act
        let settling_root = settling.paths.root.clone();
        let released = drive_admitted_codex_safe_profile_run(
            &broker,
            &active_runs,
            settling,
            &mut published,
            &mut observed_process_groups,
            |_| {},
        );
        // The production stream thread terminalizes after its terminal event. Letting it finish keeps
        // it from recreating app-owned evidence behind the scratch guard's cleanup.
        let settling_root_removed = wait_for_run_root_removal(&settling_root);
        let state = active_runs
            .state
            .lock()
            .expect("inspect Rust-owned control state");
        let settled_control_retained = state.controls.contains_key("settling-run");
        let retained_prompts = state
            .controls
            .values()
            .map(|control| control.run.request.prompt.clone())
            .collect::<Vec<_>>();
        let retained_run_ids = {
            let mut run_ids = state.controls.keys().cloned().collect::<Vec<_>>();
            run_ids.sort();
            run_ids
        };
        let publication_history_bounded =
            state.published_terminals.len() <= CODEX_SAFE_PROFILE_PUBLISHED_TERMINAL_HISTORY;
        drop(state);

        // Assert
        assert_eq!(
            published
                .labels
                .iter()
                .filter(|(run_id, _)| run_id == "settling-run")
                .map(|(_, label)| label.as_str())
                .collect::<Vec<_>>(),
            vec!["admitted", "started", "completed"],
            "the settling run reaches its public terminal through the production launch path"
        );
        assert!(
            settling_root_removed,
            "the settled run's own evidence is cleaned once its group absence is observed"
        );
        assert!(
            !settled_control_retained,
            "a settled run's control entry is dropped rather than left resident"
        );
        assert!(
            !retained_prompts
                .iter()
                .any(|prompt| prompt == settling_prompt),
            "no retained control holds the settled run's prompt bytes"
        );
        assert_eq!(
            retained_prompts,
            vec![pending_prompt],
            "only still-launchable work keeps its prompt"
        );
        assert_eq!(
            retained_run_ids,
            vec!["pending-run"],
            "the released FIFO successor is the only control left"
        );
        assert!(
            publication_history_bounded,
            "the retained terminal-publication history stays within its fixed bound"
        );
        assert_eq!(
            released.map(|next| next.request.run_id),
            Some("pending-run".to_string()),
            "dropping the settled control still releases the next FIFO request exactly once"
        );
    }

    // Each receipt pins an open descriptor for the verified executable, so a capability probe must
    // not be able to grow the registry. One receipt per identity, a replaced identity supersedes the
    // previous receipts, and a receipt that is no longer registered fails the public path closed.
    #[cfg(unix)]
    #[test]
    fn verified_receipts_are_idempotent_per_identity_and_bounded() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-codex-safe-profile-receipt-registry");
        std::fs::create_dir_all(&scratch).expect("create the receipt-registry fixture directory");
        let executable = scratch.join("codex");
        let stashed_executable = scratch.join("codex-stashed");
        let replacement_executable = scratch.join("replacement-codex");
        write_codex_prompt_fixture(&executable, &scratch.join("first-prompt"));
        write_codex_output_limit_fixture(
            &replacement_executable,
            &scratch.join("prompts"),
            &scratch.join("term-resistant-holder.ready"),
        );
        let broker = fixture_broker(&scratch, CODEX_FIXTURE_EXEC_HELP);
        let repeated_probe_count = CODEX_SAFE_PROFILE_MAX_VERIFIED_RECEIPTS * 3;

        // Act
        let mut repeated_receipt_ids = (0..repeated_probe_count)
            .map(|_| broker.capability().receipt_id)
            .collect::<Vec<_>>();
        repeated_receipt_ids.dedup();
        let first_identity_receipt_id = repeated_receipt_ids
            .first()
            .cloned()
            .flatten()
            .expect("the exact fixture descriptor yields a public capability receipt");
        let registered_after_repeated_probes = broker
            .verified_receipts
            .lock()
            .expect("inspect the broker receipt registry")
            .issued
            .len();
        std::fs::rename(&executable, &stashed_executable).expect("stash the first descriptor");
        std::fs::rename(&replacement_executable, &executable)
            .expect("install a byte-different descriptor");
        let replaced_receipt_id = broker
            .capability()
            .receipt_id
            .expect("the replacement descriptor yields its own capability receipt");
        let registered_after_replacement = broker
            .verified_receipts
            .lock()
            .expect("inspect the broker receipt registry")
            .issued
            .len();
        let superseded_lookup = broker.verified_receipt(&first_identity_receipt_id);
        let replaced_lookup = broker.verified_receipt(&replaced_receipt_id);

        // Assert
        assert_eq!(
            repeated_receipt_ids.len(),
            1,
            "repeated capability probes of one identity return one idempotent receipt"
        );
        assert_eq!(
            registered_after_repeated_probes, 1,
            "repeated capability probes register exactly one receipt"
        );
        assert_ne!(
            replaced_receipt_id, first_identity_receipt_id,
            "a changed descriptor identity is issued its own receipt"
        );
        assert!(
            registered_after_replacement <= CODEX_SAFE_PROFILE_MAX_VERIFIED_RECEIPTS,
            "the receipt registry stays within its fixed bound"
        );
        assert_eq!(
            registered_after_replacement, 1,
            "a replaced identity supersedes the receipts issued for the previous one"
        );
        assert!(
            superseded_lookup.is_err(),
            "a superseded receipt is unknown, so the public start path fails closed"
        );
        assert!(
            replaced_lookup.is_ok(),
            "the current identity's receipt remains resolvable"
        );
    }

    #[cfg(unix)]
    fn wait_for_published_label(
        published: &Arc<Mutex<Vec<(String, String)>>>,
        run_id: &str,
        label: &str,
    ) -> bool {
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            let observed = published.lock().is_ok_and(|published| {
                published.iter().any(|(published_run_id, published_label)| {
                    published_run_id == run_id && published_label == label
                })
            });
            if observed {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        false
    }

    // `tauri::test::mock_app` provides a real `AppHandle`, so this drives the production launcher and
    // the production cancel command over the real `app.emit` channel rather than a harness that
    // reproduces them. `codex_safe_profile_start` itself is deliberately not driven: on a mock app
    // `app.path().app_data_dir()` resolves to the real user Application Support directory, and a test
    // must never reserve run roots there. Everything after that command's receipt lookup and root
    // reservation is the code path below.
    #[cfg(unix)]
    #[test]
    fn real_start_and_cancel_commands_on_mock_app_follow_the_public_admission_and_terminal_contract(
    ) {
        // Arrange
        let scratch = TestScratchRoot::new("prv-codex-safe-profile-mock-app");
        std::fs::create_dir_all(&scratch).expect("create the mock-app fixture directory");
        let prompt_directory = scratch.join("delivered-prompts");
        write_codex_output_limit_fixture(
            &scratch.join("codex"),
            &prompt_directory,
            &scratch.join("term-resistant-holder.ready"),
        );
        let broker = fixture_broker(&scratch, CODEX_FIXTURE_EXEC_HELP);
        let receipt_id = broker
            .capability()
            .receipt_id
            .expect("the exact fixture descriptor yields a public capability receipt");
        let verified_launch = broker
            .verified_receipt(&receipt_id)
            .expect("the broker retains its issued capability receipt");
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        handle.manage(CodexSafeProfileActiveRuns::default());
        let published = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let recorder = Arc::clone(&published);
        use tauri::Listener;
        handle.listen("codex-safe-profile-event", move |event| {
            let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
                return;
            };
            let run_id = payload["runId"].as_str().unwrap_or_default().to_string();
            let label = match payload["type"].as_str().unwrap_or_default() {
                "failed" => format!("failed:{}", payload["code"].as_str().unwrap_or_default()),
                kind => kind.to_string(),
            };
            if let Ok(mut recorded) = recorder.lock() {
                recorded.push((run_id, label));
            }
        });
        let pr_key = "acme/web#42";
        let review_request = |run_id: &str, prompt: &str| CodexSafeProfileStartRequest {
            run_id: run_id.into(),
            pr_key: pr_key.into(),
            operation: CodexSafeProfileOperation::Review,
            prompt: prompt.into(),
            model: None,
            provenance_receipt_id: receipt_id.clone(),
        };
        let completing = review_request("mock-app-review", "mock-app-review-prompt");
        let blocking = review_request("mock-app-blocking", "mock-app-blocking-prompt");
        let cancelled = review_request("mock-app-cancelled", "mock-app-cancelled-prompt");
        let reserve = |request: &CodexSafeProfileStartRequest| {
            let paths = CodexSafeProfileRunPaths::create(&scratch, request)
                .expect("reserve a marker-owned run root");
            persist_codex_safe_profile_admission(
                &paths,
                &request.run_id,
                CodexSafeProfileAdmissionState::Queued,
                &verified_launch.provenance,
            )
            .expect("persist queued admission evidence");
            paths
        };
        let completing_paths = reserve(&completing);
        let blocking_paths = reserve(&blocking);
        let cancelled_paths = reserve(&cancelled);
        let terminal_directory = scratch
            .join("codex-safe-profile")
            .join(CODEX_SAFE_PROFILE_TERMINAL_RECOVERY_DIRECTORY);

        // Act
        let managed_runs = handle.state::<CodexSafeProfileActiveRuns>();
        let completing_queue_state = managed_runs
            .enqueue(
                completing.clone(),
                completing_paths.clone(),
                verified_launch.clone(),
            )
            .expect("the first request enters the public FIFO");
        launch_admitted_codex_safe_profile_run(
            handle.clone(),
            broker.clone(),
            &managed_runs,
            completing.clone(),
            completing_paths.clone(),
            verified_launch.clone(),
        );
        let completing_terminal_published =
            wait_for_published_label(&published, &completing.run_id, "completed");
        let completing_root_removed = wait_for_run_root_removal(&completing_paths.root);
        // A queued request is what a revoked consent cancels in production, so hold the PR's one
        // slot with a request that is never launched and cancel the one waiting behind it.
        managed_runs
            .enqueue(blocking.clone(), blocking_paths, verified_launch.clone())
            .expect("the blocking request takes the PR's single slot");
        let cancelled_queue_state = managed_runs
            .enqueue(
                cancelled.clone(),
                cancelled_paths.clone(),
                verified_launch.clone(),
            )
            .expect("the cancelled request queues behind it");
        codex_safe_profile_cancel(
            handle.clone(),
            handle.state::<CodexSafeProfileActiveRuns>(),
            CodexSafeProfileCancelRequest {
                run_id: cancelled.run_id.clone(),
            },
        )
        .expect("the real cancel command accepts a queued run");
        let cancelled_terminal_published =
            wait_for_published_label(&published, &cancelled.run_id, "failed:cancelled");
        let repeated_cancel = codex_safe_profile_cancel(
            handle.clone(),
            handle.state::<CodexSafeProfileActiveRuns>(),
            CodexSafeProfileCancelRequest {
                run_id: cancelled.run_id.clone(),
            },
        );
        let delivered_prompts = sorted_delivered_prompts(&prompt_directory);
        let lifecycle = |run_id: &str| {
            published
                .lock()
                .expect("the recorded event log remains available")
                .iter()
                .filter(|(event_run_id, label)| event_run_id == run_id && label != "progress")
                .map(|(_, label)| label.clone())
                .collect::<Vec<_>>()
        };
        let completing_lifecycle = lifecycle(&completing.run_id);
        let cancelled_lifecycle = lifecycle(&cancelled.run_id);

        // Assert
        assert_eq!(completing_queue_state, AiBrokerQueueState::Started);
        assert_eq!(cancelled_queue_state, AiBrokerQueueState::Queued);
        assert!(
            completing_terminal_published,
            "the production launcher publishes its terminal through the real event channel"
        );
        assert_eq!(
            completing_lifecycle,
            vec!["admitted", "started", "completed"],
            "the real launcher emits the public admission and terminal sequence"
        );
        assert!(
            completing_root_removed && terminal_directory.join(&completing.run_id).is_file(),
            "a completed run leaves only its opaque terminal receipt behind"
        );
        assert!(
            cancelled_terminal_published,
            "the real cancel command publishes its terminal through the real event channel"
        );
        assert_eq!(
            cancelled_lifecycle,
            vec!["failed:cancelled"],
            "cancelling queued work publishes exactly one cancelled terminal"
        );
        assert!(
            repeated_cancel.is_err(),
            "a settled run is no longer cancellable and cannot publish a second terminal"
        );
        assert_eq!(
            delivered_prompts,
            vec![completing.prompt.clone()],
            "only the launched run ever received prompt bytes"
        );

        let _ = managed_runs.shutdown();
    }

    #[test]
    fn admission_acknowledgement_generation_guarded_storage_recovers_unstarted_terminal_work() {
        // Arrange
        let scratch = TestScratchRoot::new("prv-ai-broker-admission-recovery");
        let request = CodexSafeProfileStartRequest {
            run_id: "unstarted-admission".into(),
            pr_key: "acme/web#42".into(),
            operation: CodexSafeProfileOperation::Review,
            prompt: "bounded app-owned prompt".into(),
            model: None,
            provenance_receipt_id: "test-receipt".into(),
        };
        let paths = CodexSafeProfileRunPaths::create(&scratch, &request)
            .expect("reserve marker-owned unstarted run root");
        let verified = test_verified_launch();
        persist_codex_safe_profile_admission(
            &paths,
            &request.run_id,
            CodexSafeProfileAdmissionState::Preparing,
            &verified.provenance,
        )
        .expect("persist pre-spawn admission evidence");

        // Act
        let recovered = recover_codex_safe_profile_transients(&scratch)
            .expect("recover only safely unstarted broker work");

        // Assert
        assert_eq!(recovered, vec![request.run_id]);
        assert!(
            !paths.root.exists(),
            "preparing work never had a child or webview admission and is terminally recovered"
        );
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn queued_codex_run_cancels_before_start_and_releases_next_pr_slot() {
        // Arrange
        let active_runs = CodexSafeProfileActiveRuns {
            state: Mutex::new(CodexSafeProfileRunState {
                queue: AiBrokerQueue::new(1, 1).expect("valid fixed broker queue limits"),
                controls: HashMap::new(),
                published_terminals: VecDeque::new(),
                shutting_down: false,
            }),
        };
        let request = |run_id: &str, pr_key: &str| CodexSafeProfileStartRequest {
            run_id: run_id.into(),
            pr_key: pr_key.into(),
            operation: CodexSafeProfileOperation::Review,
            prompt: "bounded app-owned prompt".into(),
            model: None,
            provenance_receipt_id: "test-receipt".into(),
        };
        assert_eq!(
            active_runs
                .enqueue(
                    request("active-run", "acme/web#42"),
                    test_queued_paths("active-run"),
                    test_verified_launch()
                )
                .expect("first run admits"),
            AiBrokerQueueState::Started
        );
        assert_eq!(
            active_runs
                .enqueue(
                    request("cancelled-run", "acme/web#42"),
                    test_queued_paths("cancelled-run"),
                    test_verified_launch()
                )
                .expect("same-PR run queues"),
            AiBrokerQueueState::Queued
        );
        assert_eq!(
            active_runs
                .enqueue(
                    request("next-run", "acme/api#7"),
                    test_queued_paths("next-run"),
                    test_verified_launch()
                )
                .expect("global-limit run queues"),
            AiBrokerQueueState::Queued
        );

        // Act
        let cancelled_before_start = active_runs
            .cancel("cancelled-run")
            .expect("queued cancellation succeeds");
        let released = active_runs.release("active-run").expect("release succeeds");

        // Assert
        assert!(
            cancelled_before_start,
            "queued work has no child process to launch or cancel"
        );
        let next = released.expect("the next eligible queued run receives the released slot");
        assert_eq!(
            next.request.run_id, "next-run",
            "FIFO eligible work starts on release"
        );
        let state = active_runs
            .state
            .lock()
            .expect("queue state remains available");
        assert!(
            !state.queue.active.contains_key("cancelled-run"),
            "a cancelled queued run never receives a process slot"
        );
        assert_eq!(
            state.queue.active.get("next-run"),
            Some(&"acme/api#7".to_string())
        );
    }

    #[test]
    fn queue_enforces_global_and_per_pr_limits() {
        // Arrange
        let mut queue = AiBrokerQueue::new(2, 1).expect("valid broker queue limits");

        // Act
        let first = queue.enqueue("run-a1".into(), "owner/repo#1".into());
        let same_pr = queue.enqueue("run-a2".into(), "owner/repo#1".into());
        let second_pr = queue.enqueue("run-b1".into(), "owner/repo#2".into());
        let globally_queued = queue.enqueue("run-c1".into(), "owner/repo#3".into());
        let admitted_after_release = queue.release("run-a1");

        // Assert
        assert_eq!(first, Ok(AiBrokerQueueState::Started));
        assert_eq!(same_pr, Ok(AiBrokerQueueState::Queued));
        assert_eq!(second_pr, Ok(AiBrokerQueueState::Started));
        assert_eq!(globally_queued, Ok(AiBrokerQueueState::Queued));
        assert_eq!(admitted_after_release, Some("run-a2".into()));
    }

    #[test]
    fn jira_mcp_capability_remains_fail_closed_without_local_schema_proof() {
        // Arrange
        let expected_diagnostic =
            "Installed Jira MCP declarations and tool schemas have not been proven locally.";

        // Act
        let capability = jira_mcp_read_capability_diagnostic();

        // Assert
        assert_eq!(capability.status, JiraMcpReadCapabilityStatus::Unavailable);
        assert!(capability.server.is_none());
        assert!(capability.tool.is_none());
        assert!(capability
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic == expected_diagnostic));
    }

    #[test]
    fn permission_gate_requires_one_matching_explicit_decision() {
        // Arrange
        let mut gate = AiPendingPermissionGate::new();
        let request = AiBrokerPermissionRequest {
            request_id: "permission-1".into(),
            run_id: "run-1".into(),
            kind: AiBrokerPermissionKind::Command,
        };
        gate.register(request.clone())
            .expect("register an exact broker-owned request");

        // Act
        let denied = gate.resolve("permission-1", AiBrokerPermissionDecision::Deny);
        let replay = gate.resolve("permission-1", AiBrokerPermissionDecision::AllowOnce);
        let unknown = gate.resolve("permission-other", AiBrokerPermissionDecision::AllowOnce);

        // Assert
        assert_eq!(
            denied,
            Ok((request, AiBrokerPermissionDecision::Deny)),
            "the exact pending request receives its one explicit decision"
        );
        assert!(
            replay.is_err(),
            "a decision cannot be replayed as a durable grant"
        );
        assert!(
            unknown.is_err(),
            "the webview cannot decide an invented request ID"
        );
    }

    #[test]
    fn event_streaming_bounds_child_output_lines() {
        // Arrange
        let untrusted_child_output = "x".repeat(4_200);

        // Act
        let sanitized_event_output =
            sanitize_event_line(untrusted_child_output, BROKER_MAX_EVENT_LINE_LENGTH);

        // Assert
        assert_eq!(
            sanitized_event_output.chars().count(),
            BROKER_MAX_EVENT_LINE_LENGTH
        );
    }
}
