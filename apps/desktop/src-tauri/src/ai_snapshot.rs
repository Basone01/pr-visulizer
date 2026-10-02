// The broker prepares review source from Git objects at the requested PR head, never from the
// caller's working-tree files. This module intentionally has no Tauri command: a future
// lifecycle bridge can request a typed snapshot, but the webview cannot choose arbitrary process
// or filesystem operations.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const SNAPSHOT_DIRECTORY_NAME: &str = "pr-visualizer-ai-review-snapshots";
const SNAPSHOT_METADATA_NAME: &str = "snapshot.json";
const SNAPSHOT_SOURCE_DIRECTORY_NAME: &str = "source";
const SNAPSHOT_FORMAT_VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AiSnapshotMode {
    HardExclusion,
    FullGitHistory,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AiSnapshotPolicy {
    pub mode: AiSnapshotMode,
    pub custom_excluded_paths: Vec<String>,
    pub max_file_bytes: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct AiSnapshotRequest {
    pub repository_root: PathBuf,
    pub head_sha: String,
    pub policy: AiSnapshotPolicy,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AiSnapshotExclusion {
    pub path: String,
    pub reason: &'static str,
}

#[derive(Clone, Debug)]
pub(crate) struct AiPreparedSnapshot {
    pub source_path: PathBuf,
    pub head_sha: String,
    pub exclusions: Vec<AiSnapshotExclusion>,
    parent_path: PathBuf,
}

#[derive(Deserialize, Serialize)]
struct SnapshotMetadata {
    format_version: u8,
    head_sha: String,
}

#[derive(Clone, Debug)]
struct GitTreeEntry {
    mode: String,
    object_type: String,
    path: String,
}

impl GitTreeEntry {
    fn is_submodule(&self) -> bool {
        self.mode == "160000" && self.object_type == "commit"
    }
}

#[cfg(unix)]
const DISABLED_GIT_CONFIG_PATH: &str = "/dev/null";
#[cfg(not(unix))]
const DISABLED_GIT_CONFIG_PATH: &str = "NUL";

fn isolated_git_command() -> Command {
    let mut command = Command::new("git");
    command
        // Git configuration and protocol environment inherited from the desktop process is
        // untrusted repository context. The snapshot only reads its verified local source.
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", DISABLED_GIT_CONFIG_PATH)
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_ALLOW_PROTOCOL", "file")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_LFS_SKIP_SMUDGE", "1")
        .arg("-c")
        .arg(format!("core.hooksPath={DISABLED_GIT_CONFIG_PATH}"))
        .arg("-c")
        .arg(format!("core.attributesFile={DISABLED_GIT_CONFIG_PATH}"))
        .arg("-c")
        .arg("filter.lfs.smudge=")
        .arg("-c")
        .arg("filter.lfs.process=")
        .arg("-c")
        .arg("filter.lfs.required=false")
        .arg("-c")
        .arg("fetch.recurseSubmodules=false")
        .arg("-c")
        .arg("submodule.recurse=false");
    command
}

fn full_history_clone_configurations() -> [String; 8] {
    [
        format!("core.hooksPath={DISABLED_GIT_CONFIG_PATH}"),
        format!("core.attributesFile={DISABLED_GIT_CONFIG_PATH}"),
        "filter.lfs.smudge=".to_string(),
        "filter.lfs.process=".to_string(),
        "filter.lfs.required=false".to_string(),
        "fetch.recurseSubmodules=false".to_string(),
        "submodule.recurse=false".to_string(),
        "remote.origin.promisor=false".to_string(),
    ]
}

fn validated_repository_root(root: &Path) -> Result<PathBuf, String> {
    let resolved = root
        .canonicalize()
        .map_err(|error| format!("repository root is not accessible: {error}"))?;
    if !resolved.is_dir() {
        return Err("repository root is not a directory".into());
    }
    Ok(resolved)
}

fn validated_head_sha(head_sha: &str) -> Result<&str, String> {
    if head_sha.len() == 40
        && head_sha
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Ok(head_sha);
    }
    Err("snapshot head SHA must be a full 40-character hexadecimal Git object ID".into())
}

fn git_output(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = isolated_git_command()
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|error| format!("snapshot Git command could not start: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "snapshot Git command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}

fn resolved_commit_sha(root: &Path, requested_head_sha: &str) -> Result<String, String> {
    let revision = format!("{requested_head_sha}^{{commit}}");
    let stdout = git_output(root, &["rev-parse", "--verify", "--quiet", &revision])?;
    let resolved = String::from_utf8(stdout)
        .map_err(|_| "Git returned a non-UTF-8 commit SHA".to_string())?
        .trim()
        .to_string();
    if !resolved.eq_ignore_ascii_case(requested_head_sha) {
        return Err("snapshot head SHA did not resolve to the requested exact commit".into());
    }
    Ok(resolved)
}

fn normalize_repository_path(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    if normalized.is_empty() || normalized.starts_with('/') {
        return None;
    }
    if normalized
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return None;
    }
    Some(normalized)
}

fn normalized_custom_exclusions(policy: &AiSnapshotPolicy) -> Result<Vec<String>, String> {
    policy
        .custom_excluded_paths
        .iter()
        .map(|path| {
            normalize_repository_path(path).ok_or_else(|| {
                format!("custom repository exclusion is not repository-relative: {path}")
            })
        })
        .collect()
}

fn list_git_tree_entries(root: &Path, head_sha: &str) -> Result<Vec<GitTreeEntry>, String> {
    let stdout = git_output(root, &["ls-tree", "-r", "-z", head_sha])?;
    stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .map(|record| {
            let record = std::str::from_utf8(record)
                .map_err(|_| "snapshot excludes Git paths that are not UTF-8".to_string())?;
            let (header, path) = record
                .split_once('\t')
                .ok_or_else(|| "Git tree record is malformed".to_string())?;
            let mut header_parts = header.split_whitespace();
            let mode = header_parts
                .next()
                .ok_or_else(|| "Git tree record is missing a mode".to_string())?;
            let object_type = header_parts
                .next()
                .ok_or_else(|| "Git tree record is missing an object type".to_string())?;
            if header_parts.next().is_none()
                || (object_type != "blob" && !(mode == "160000" && object_type == "commit"))
            {
                return Err("snapshot excludes unsupported Git tree entries".into());
            }
            let path = normalize_repository_path(path)
                .ok_or_else(|| "snapshot excludes an unsafe Git tree path".to_string())?;
            Ok(GitTreeEntry {
                mode: mode.to_string(),
                object_type: object_type.to_string(),
                path,
            })
        })
        .collect()
}

fn git_blob(root: &Path, head_sha: &str, path: &str) -> Result<Vec<u8>, String> {
    let object = format!("{head_sha}:{path}");
    git_output(root, &["cat-file", "blob", &object])
}

fn is_git_lfs_pointer(content: &[u8]) -> bool {
    let Ok(pointer) = std::str::from_utf8(content) else {
        return false;
    };
    let mut lines = pointer.lines();
    if lines.next() != Some("version https://git-lfs.github.com/spec/v1") {
        return false;
    }
    let Some(oid) = lines
        .next()
        .and_then(|line| line.strip_prefix("oid sha256:"))
    else {
        return false;
    };
    let Some(size) = lines.next().and_then(|line| line.strip_prefix("size ")) else {
        return false;
    };

    oid.len() == 64
        && oid.chars().all(|character| character.is_ascii_hexdigit())
        && !size.is_empty()
        && size.chars().all(|character| character.is_ascii_digit())
}

fn custom_exclusion_matches(path: &str, exclusions: &[String]) -> bool {
    exclusions
        .iter()
        .any(|excluded| path == excluded || path.starts_with(&format!("{excluded}/")))
}

fn sensitive_path_reason(
    path: &str,
    is_binary: bool,
    is_symlink: bool,
    custom_exclusions: &[String],
) -> Option<&'static str> {
    let segments: Vec<_> = path.split('/').collect();
    let filename = segments.last()?.to_ascii_lowercase();
    let lowercase_segments: Vec<_> = segments
        .iter()
        .map(|segment| segment.to_ascii_lowercase())
        .collect();

    if custom_exclusion_matches(path, custom_exclusions) {
        return Some("custom-exclusion");
    }
    if lowercase_segments.iter().any(|segment| {
        matches!(
            segment.as_str(),
            ".git" | "bower_components" | "node_modules" | "vendor"
        )
    }) {
        return Some("dependency-directory");
    }
    if lowercase_segments.iter().any(|segment| {
        matches!(
            segment.as_str(),
            ".generated" | "__generated__" | "build" | "dist" | "generated"
        )
    }) {
        return Some("generated-or-vendored-content");
    }
    if filename.starts_with(".env") {
        return Some("environment-file");
    }
    if matches!(
        filename.as_str(),
        ".npmrc"
            | "credentials"
            | "credentials.json"
            | "id_dsa"
            | "id_ecdsa"
            | "id_ed25519"
            | "id_rsa"
    ) || [".key", ".keystore", ".p12", ".pem", ".pfx"]
        .iter()
        .any(|extension| filename.ends_with(extension))
    {
        return Some("credential-file");
    }
    if [".map", ".min.js", ".min.css", ".pb.go"]
        .iter()
        .any(|suffix| filename.ends_with(suffix))
    {
        return Some("generated-or-vendored-content");
    }
    // A Git tree symlink can traverse an arbitrary chain after materialization. Reject every
    // source-tree symlink instead of relying on lexical target containment.
    if is_symlink {
        return Some("symlink-source-entry");
    }
    if is_binary {
        return Some("binary-file");
    }
    None
}

fn snapshot_base_directory() -> Result<PathBuf, String> {
    let base = std::env::temp_dir().join(SNAPSHOT_DIRECTORY_NAME);
    fs::create_dir_all(&base)
        .map_err(|error| format!("create snapshot base directory: {error}"))?;
    let resolved = base
        .canonicalize()
        .map_err(|error| format!("snapshot base directory is not accessible: {error}"))?;
    if !resolved.is_dir() {
        return Err("snapshot base path is not a directory".into());
    }
    set_directory_read_write(&resolved)?;
    Ok(resolved)
}

fn unique_snapshot_parent(base: &Path) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("system clock is before Unix epoch: {error}"))?
        .as_nanos();
    for nonce in 0..100 {
        let candidate = base.join(format!("{}-{timestamp}-{nonce}", std::process::id()));
        match fs::create_dir(&candidate) {
            Ok(()) => {
                set_directory_read_write(&candidate)?;
                return Ok(candidate);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("create snapshot directory: {error}")),
        }
    }
    Err("could not allocate a unique snapshot directory".into())
}

fn source_path(parent: &Path) -> PathBuf {
    parent.join(SNAPSHOT_SOURCE_DIRECTORY_NAME)
}

fn destination_path(source: &Path, repository_path: &str) -> Result<PathBuf, String> {
    let path = normalize_repository_path(repository_path)
        .ok_or_else(|| "snapshot destination path is unsafe".to_string())?;
    Ok(source.join(path))
}

fn write_regular_file(destination: &Path, content: &[u8]) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "snapshot destination has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("create snapshot directory: {error}"))?;
    fs::write(destination, content).map_err(|error| format!("write snapshot file: {error}"))?;
    set_file_read_only(destination)
}

fn set_file_read_only(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o400))
            .map_err(|error| format!("set snapshot file read-only: {error}"))?;
    }
    #[cfg(not(unix))]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|error| format!("snapshot file metadata: {error}"))?
            .permissions();
        permissions.set_readonly(true);
        fs::set_permissions(path, permissions)
            .map_err(|error| format!("set snapshot file read-only: {error}"))?;
    }
    Ok(())
}

fn set_directory_read_only(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o500))
            .map_err(|error| format!("set snapshot directory read-only: {error}"))?;
    }
    #[cfg(not(unix))]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|error| format!("snapshot directory metadata: {error}"))?
            .permissions();
        permissions.set_readonly(true);
        fs::set_permissions(path, permissions)
            .map_err(|error| format!("set snapshot directory read-only: {error}"))?;
    }
    Ok(())
}

fn set_directory_read_write(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("set snapshot directory writable: {error}"))?;
    }
    #[cfg(not(unix))]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|error| format!("snapshot directory metadata: {error}"))?
            .permissions();
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions)
            .map_err(|error| format!("set snapshot directory writable: {error}"))?;
    }
    Ok(())
}

fn lock_snapshot_directories(path: &Path) -> Result<(), String> {
    for entry in fs::read_dir(path).map_err(|error| format!("read snapshot directory: {error}"))? {
        let entry = entry.map_err(|error| format!("read snapshot directory entry: {error}"))?;
        let entry_path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("read snapshot file type: {error}"))?;
        if file_type.is_dir() {
            lock_snapshot_directories(&entry_path)?;
            set_directory_read_only(&entry_path)?;
        } else if !file_type.is_symlink() {
            set_file_read_only(&entry_path)?;
        }
    }
    set_directory_read_only(path)
}

fn remove_read_only_tree(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("read snapshot cleanup metadata: {error}"))?;
    if metadata.file_type().is_symlink() {
        fs::remove_file(path).map_err(|error| format!("remove snapshot symlink: {error}"))?;
        return Ok(());
    }
    if metadata.is_dir() {
        // The ownership marker was verified before this recursive cleanup starts. Restore write
        // permission only on this broker-owned directory immediately before unlinking its
        // children; files remain read-only because directory write permission is sufficient on
        // Unix to remove them.
        set_directory_read_write(path)?;
        for entry in fs::read_dir(path)
            .map_err(|error| format!("read snapshot cleanup directory: {error}"))?
        {
            let entry = entry.map_err(|error| format!("read snapshot cleanup entry: {error}"))?;
            remove_read_only_tree(&entry.path())?;
        }
        fs::remove_dir(path).map_err(|error| format!("remove snapshot directory: {error}"))?;
        return Ok(());
    }

    #[cfg(not(unix))]
    {
        let mut permissions = metadata.permissions();
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions)
            .map_err(|error| format!("set snapshot file writable: {error}"))?;
    }
    fs::remove_file(path).map_err(|error| format!("remove snapshot file: {error}"))
}

fn write_snapshot_metadata(parent: &Path, head_sha: &str) -> Result<(), String> {
    let metadata = SnapshotMetadata {
        format_version: SNAPSHOT_FORMAT_VERSION,
        head_sha: head_sha.to_string(),
    };
    let encoded = serde_json::to_vec(&metadata)
        .map_err(|error| format!("serialize snapshot ownership metadata: {error}"))?;
    let path = parent.join(SNAPSHOT_METADATA_NAME);
    fs::write(&path, encoded)
        .map_err(|error| format!("write snapshot ownership metadata: {error}"))?;
    set_file_read_only(&path)
}

fn materialize_source_tree(
    source: &Path,
    repository_root: &Path,
    head_sha: &str,
    policy: &AiSnapshotPolicy,
    custom_exclusions: &[String],
) -> Result<Vec<AiSnapshotExclusion>, String> {
    fs::create_dir_all(source)
        .map_err(|error| format!("create snapshot source directory: {error}"))?;
    let mut exclusions = Vec::new();

    for entry in list_git_tree_entries(repository_root, head_sha)? {
        if entry.is_submodule() {
            exclusions.push(AiSnapshotExclusion {
                path: entry.path,
                reason: "submodule-content-unavailable",
            });
            continue;
        }

        let destination = destination_path(source, &entry.path)?;
        let is_symlink = entry.mode == "120000";
        let content = git_blob(repository_root, head_sha, &entry.path)?;
        let reason = is_git_lfs_pointer(&content)
            .then_some("git-lfs-content-unavailable")
            .or_else(|| {
                sensitive_path_reason(
                    &entry.path,
                    content.contains(&0),
                    is_symlink,
                    custom_exclusions,
                )
            })
            .or_else(|| (content.len() as u64 > policy.max_file_bytes).then_some("oversized-file"));

        if let Some(reason) = reason {
            exclusions.push(AiSnapshotExclusion {
                path: entry.path,
                reason,
            });
        } else {
            write_regular_file(&destination, &content)?;
        }
    }
    lock_snapshot_directories(source)?;
    Ok(exclusions)
}

fn prepare_hard_exclusion_snapshot(
    source: &Path,
    repository_root: &Path,
    head_sha: &str,
    policy: &AiSnapshotPolicy,
    custom_exclusions: &[String],
) -> Result<Vec<AiSnapshotExclusion>, String> {
    materialize_source_tree(source, repository_root, head_sha, policy, custom_exclusions)
}

fn pin_full_history_git_metadata(source: &Path, head_sha: &str) -> Result<(), String> {
    // Keep the requested commit available to Git-aware review context without checking it out:
    // checkout can execute repository-defined filters or hooks. `read-tree` writes only this
    // isolated clone's index, and `update-ref --no-deref` pins its HEAD directly to the same
    // already validated commit.
    git_output(source, &["read-tree", head_sha])?;
    git_output(source, &["update-ref", "--no-deref", "HEAD", head_sha])?;

    if resolved_commit_sha(source, head_sha)? != head_sha {
        return Err("full-history snapshot Git HEAD did not pin to the requested commit".into());
    }
    git_output(
        source,
        &["diff-index", "--cached", "--quiet", head_sha, "--"],
    )?;
    Ok(())
}

fn prepare_full_history_snapshot(
    source: &Path,
    repository_root: &Path,
    head_sha: &str,
    policy: &AiSnapshotPolicy,
    custom_exclusions: &[String],
) -> Result<Vec<AiSnapshotExclusion>, String> {
    let mut clone = isolated_git_command();
    clone
        .arg("clone")
        .args(["--no-local", "--no-checkout", "--quiet"]);
    for configuration in full_history_clone_configurations() {
        clone.arg("--config").arg(configuration);
    }
    let output = clone
        .arg(repository_root)
        .arg(source)
        .output()
        .map_err(|error| format!("clone full-history snapshot could not start: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "clone full-history snapshot failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    // Do not check out the clone: a checkout may run repository-defined filters, hooks, or
    // LFS smudge commands. Pin Git metadata with object/index operations, then materialize the
    // policy-filtered working tree from verified blobs; `.git` remains available for the
    // explicitly disclosed full-history trade-off.
    pin_full_history_git_metadata(source, head_sha)?;
    materialize_source_tree(source, repository_root, head_sha, policy, custom_exclusions)
}

pub(crate) fn prepare_snapshot(request: AiSnapshotRequest) -> Result<AiPreparedSnapshot, String> {
    if request.policy.max_file_bytes == 0 {
        return Err("snapshot policy requires a positive maximum file size".into());
    }
    let requested_head_sha = validated_head_sha(&request.head_sha)?;
    let repository_root = validated_repository_root(&request.repository_root)?;
    let head_sha = resolved_commit_sha(&repository_root, requested_head_sha)?;
    let custom_exclusions = normalized_custom_exclusions(&request.policy)?;
    let snapshot_base = snapshot_base_directory()?;
    let parent = unique_snapshot_parent(&snapshot_base)?;
    let source = source_path(&parent);

    let result = match request.policy.mode {
        AiSnapshotMode::HardExclusion => prepare_hard_exclusion_snapshot(
            &source,
            &repository_root,
            &head_sha,
            &request.policy,
            &custom_exclusions,
        ),
        AiSnapshotMode::FullGitHistory => prepare_full_history_snapshot(
            &source,
            &repository_root,
            &head_sha,
            &request.policy,
            &custom_exclusions,
        ),
    };
    let exclusions = match result {
        Ok(exclusions) => exclusions,
        Err(error) => {
            let _ = remove_read_only_tree(&parent);
            return Err(error);
        }
    };
    if let Err(error) = write_snapshot_metadata(&parent, &head_sha) {
        let _ = remove_read_only_tree(&parent);
        return Err(error);
    }

    Ok(AiPreparedSnapshot {
        source_path: source,
        head_sha,
        exclusions,
        parent_path: parent,
    })
}

pub(crate) fn cleanup_snapshot(snapshot: AiPreparedSnapshot) -> Result<(), String> {
    let snapshot_base = snapshot_base_directory()?;
    let parent = snapshot
        .parent_path
        .canonicalize()
        .map_err(|error| format!("snapshot ownership directory is not accessible: {error}"))?;
    if !parent.starts_with(&snapshot_base)
        || parent.file_name().is_none()
        || snapshot.source_path != source_path(&parent)
    {
        return Err(
            "refusing to clean a snapshot outside the broker-owned temporary directory".into(),
        );
    }

    let metadata_path = parent.join(SNAPSHOT_METADATA_NAME);
    let metadata: SnapshotMetadata = serde_json::from_slice(
        &fs::read(&metadata_path)
            .map_err(|error| format!("read snapshot ownership metadata: {error}"))?,
    )
    .map_err(|error| format!("parse snapshot ownership metadata: {error}"))?;
    if metadata.format_version != SNAPSHOT_FORMAT_VERSION || metadata.head_sha != snapshot.head_sha
    {
        return Err("refusing to clean a snapshot with mismatched ownership metadata".into());
    }

    remove_read_only_tree(&parent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn git_in(directory: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(directory)
            .args(args)
            .env("GIT_AUTHOR_NAME", "snapshot-test")
            .env("GIT_AUTHOR_EMAIL", "snapshot-test@example.test")
            .env("GIT_COMMITTER_NAME", "snapshot-test")
            .env("GIT_COMMITTER_EMAIL", "snapshot-test@example.test")
            .output()
            .expect("Git command runs");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[cfg(unix)]
    fn scratch_repository() -> (PathBuf, String) {
        use std::os::unix::fs::symlink;

        let scratch = std::env::temp_dir().join(format!(
            "prv-ai-snapshot-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock is after epoch")
                .as_nanos()
        ));
        fs::create_dir_all(scratch.join("src")).expect("create source directory");
        fs::create_dir_all(scratch.join("keys")).expect("create key directory");
        fs::create_dir_all(scratch.join("node_modules/pkg")).expect("create dependency directory");
        fs::create_dir_all(scratch.join("src/generated")).expect("create generated directory");
        fs::create_dir_all(scratch.join("assets")).expect("create asset directory");
        fs::write(
            scratch.join("src/review.ts"),
            "export const review = 'head'\n",
        )
        .expect("write safe source");
        fs::write(scratch.join(".env.local"), "SECRET=not-for-review\n").expect("write env file");
        fs::write(scratch.join("keys/deploy.pem"), "private-key\n").expect("write key file");
        fs::write(
            scratch.join("node_modules/pkg/index.js"),
            "module.exports = {}\n",
        )
        .expect("write dependency file");
        fs::write(scratch.join("src/generated/client.ts"), "generated\n")
            .expect("write generated file");
        fs::write(scratch.join("assets/logo.png"), [0_u8, 159, 146, 150])
            .expect("write binary file");
        fs::write(scratch.join("src/large.ts"), "x".repeat(101)).expect("write oversized file");
        symlink("../../outside", scratch.join("src/external")).expect("write escaping symlink");
        git_in(&scratch, &["init", "--quiet"]);
        git_in(&scratch, &["add", "."]);
        git_in(&scratch, &["commit", "--quiet", "-m", "snapshot fixture"]);
        let head_sha = git_in(&scratch, &["rev-parse", "HEAD"]);
        fs::write(
            scratch.join("src/review.ts"),
            "export const review = 'working-tree'\n",
        )
        .expect("change active working tree after commit");
        (scratch, head_sha)
    }

    #[cfg(unix)]
    #[test]
    fn prepared_snapshot_excludes_sensitive_paths_without_mutating_source() {
        // Arrange
        let (repository_root, head_sha) = scratch_repository();
        let working_tree_before = git_in(&repository_root, &["status", "--porcelain"]);
        let request = AiSnapshotRequest {
            repository_root: repository_root.clone(),
            head_sha,
            policy: AiSnapshotPolicy {
                mode: AiSnapshotMode::HardExclusion,
                custom_excluded_paths: vec![],
                max_file_bytes: 100,
            },
        };

        // Act
        let snapshot = prepare_snapshot(request).expect("prepare a hard-exclusion snapshot");
        let working_tree_after = git_in(&repository_root, &["status", "--porcelain"]);
        let snapshot_review_source = fs::read_to_string(snapshot.source_path.join("src/review.ts"))
            .expect("read snapshot source");
        let excluded: std::collections::HashSet<_> = snapshot
            .exclusions
            .iter()
            .map(|exclusion| (exclusion.path.clone(), exclusion.reason))
            .collect();
        let snapshot_path = snapshot.source_path.clone();
        cleanup_snapshot(snapshot).expect("clean broker-owned snapshot");

        // Assert
        assert_eq!(working_tree_after, working_tree_before);
        assert_eq!(snapshot_review_source, "export const review = 'head'\n");
        assert!(!snapshot_path.join(".git").exists());
        assert!(
            !snapshot_path.exists(),
            "cleanup removes the app-owned source area"
        );
        assert_eq!(
            excluded,
            std::collections::HashSet::from([
                (".env.local".to_string(), "environment-file"),
                ("keys/deploy.pem".to_string(), "credential-file"),
                (
                    "node_modules/pkg/index.js".to_string(),
                    "dependency-directory"
                ),
                (
                    "src/generated/client.ts".to_string(),
                    "generated-or-vendored-content"
                ),
                ("assets/logo.png".to_string(), "binary-file"),
                ("src/large.ts".to_string(), "oversized-file"),
                ("src/external".to_string(), "symlink-source-entry"),
            ])
        );

        let _ = fs::remove_dir_all(repository_root);
    }

    #[cfg(unix)]
    static ENVIRONMENT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[cfg(unix)]
    struct EnvironmentVariableGuard {
        key: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    #[cfg(unix)]
    impl Drop for EnvironmentVariableGuard {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous {
                std::env::set_var(self.key, previous);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    #[cfg(unix)]
    fn override_environment_variable(key: &'static str, value: &Path) -> EnvironmentVariableGuard {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        EnvironmentVariableGuard { key, previous }
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_rejects_symlinked_source_entry() {
        // Arrange
        let (repository_root, head_sha) = scratch_repository();
        let request = AiSnapshotRequest {
            repository_root: repository_root.clone(),
            head_sha,
            policy: AiSnapshotPolicy {
                mode: AiSnapshotMode::HardExclusion,
                custom_excluded_paths: vec![],
                max_file_bytes: 100,
            },
        };

        // Act
        let snapshot = prepare_snapshot(request).expect("prepare a hard-exclusion snapshot");
        let source_link = snapshot.source_path.join("src/external");
        let source_link_is_absent = fs::symlink_metadata(&source_link).is_err();
        let symlink_exclusion_reason = snapshot
            .exclusions
            .iter()
            .find(|exclusion| exclusion.path == "src/external")
            .map(|exclusion| exclusion.reason);
        cleanup_snapshot(snapshot).expect("clean broker-owned snapshot");

        // Assert
        assert!(source_link_is_absent);
        assert_eq!(symlink_exclusion_reason, Some("symlink-source-entry"));

        let _ = fs::remove_dir_all(repository_root);
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_reports_submodule_and_lfs_pointer_as_missing_content() {
        // Arrange
        let (repository_root, _) = scratch_repository();
        let submodule_commit = git_in(&repository_root, &["rev-parse", "HEAD"]);
        let submodule_index_entry = format!("160000,{submodule_commit},modules/required");
        git_in(
            &repository_root,
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &submodule_index_entry,
            ],
        );
        let lfs_pointer_path = repository_root.join("assets/large-model.bin");
        fs::write(
            &lfs_pointer_path,
            concat!(
                "version https://git-lfs.github.com/spec/v1\n",
                "oid sha256:4cac19622fc3ada9c0fdeadb6d25d146c8e7a82d866cb8bf2f8be1c4b85c4b9f\n",
                "size 10485760\n",
            ),
        )
        .expect("write Git LFS pointer fixture");
        git_in(&repository_root, &["add", "assets/large-model.bin"]);
        git_in(
            &repository_root,
            &[
                "commit",
                "--quiet",
                "-m",
                "add unavailable content fixtures",
            ],
        );
        let head_sha = git_in(&repository_root, &["rev-parse", "HEAD"]);
        let expected_exclusions = std::collections::HashSet::from([
            (
                "assets/large-model.bin".to_string(),
                "git-lfs-content-unavailable",
            ),
            (
                "modules/required".to_string(),
                "submodule-content-unavailable",
            ),
        ]);

        // Act
        let snapshots: Vec<_> = [
            AiSnapshotMode::HardExclusion,
            AiSnapshotMode::FullGitHistory,
        ]
        .into_iter()
        .map(|mode| {
            prepare_snapshot(AiSnapshotRequest {
                repository_root: repository_root.clone(),
                head_sha: head_sha.clone(),
                policy: AiSnapshotPolicy {
                    mode,
                    custom_excluded_paths: vec![],
                    max_file_bytes: 1024,
                },
            })
            .expect("prepare snapshot without fetching unavailable content")
        })
        .collect();
        let results: Vec<_> = snapshots
            .iter()
            .map(|snapshot| {
                let excluded: std::collections::HashSet<_> = snapshot
                    .exclusions
                    .iter()
                    .map(|exclusion| (exclusion.path.clone(), exclusion.reason))
                    .collect();
                (
                    excluded,
                    snapshot.source_path.join("assets/large-model.bin").exists(),
                    snapshot.source_path.join("modules/required").exists(),
                    snapshot.source_path.join("src/review.ts").exists(),
                )
            })
            .collect();
        for snapshot in snapshots {
            cleanup_snapshot(snapshot).expect("clean broker-owned snapshot");
        }

        // Assert
        for (
            excluded,
            lfs_pointer_materialized,
            submodule_materialized,
            safe_source_materialized,
        ) in results
        {
            assert!(expected_exclusions.is_subset(&excluded));
            assert!(
                !lfs_pointer_materialized,
                "LFS pointer text is not review source"
            );
            assert!(
                !submodule_materialized,
                "submodule content is unavailable without an approved fetch"
            );
            assert!(
                safe_source_materialized,
                "safe blob materialization still succeeds"
            );
        }

        let _ = fs::remove_dir_all(repository_root);
    }

    #[cfg(unix)]
    #[test]
    fn full_history_snapshot_git_metadata_is_pinned_to_requested_revision() {
        // Arrange
        let (repository_root, _) = scratch_repository();
        fs::write(
            repository_root.join("src/review.ts"),
            "export const review = 'revision-a'\n",
        )
        .expect("write requested revision source");
        git_in(&repository_root, &["add", "src/review.ts"]);
        git_in(
            &repository_root,
            &["commit", "--quiet", "-m", "requested revision"],
        );
        let requested_head_sha = git_in(&repository_root, &["rev-parse", "HEAD"]);
        fs::write(
            repository_root.join("src/review.ts"),
            "export const review = 'revision-b'\n",
        )
        .expect("write later source revision");
        git_in(&repository_root, &["add", "src/review.ts"]);
        git_in(
            &repository_root,
            &["commit", "--quiet", "-m", "later revision"],
        );
        let source_head_before_snapshot = git_in(&repository_root, &["rev-parse", "HEAD"]);
        let request = AiSnapshotRequest {
            repository_root: repository_root.clone(),
            head_sha: requested_head_sha.clone(),
            policy: AiSnapshotPolicy {
                mode: AiSnapshotMode::FullGitHistory,
                custom_excluded_paths: vec![],
                max_file_bytes: 1024,
            },
        };

        // Act
        let snapshot = prepare_snapshot(request).expect("prepare a revision-pinned snapshot");
        let snapshot_head = git_in(&snapshot.source_path, &["rev-parse", "HEAD"]);
        let index_matches_requested_head = git_in(
            &snapshot.source_path,
            &[
                "diff-index",
                "--cached",
                "--quiet",
                &requested_head_sha,
                "--",
            ],
        );
        let source_head_after_snapshot = git_in(&repository_root, &["rev-parse", "HEAD"]);
        let materialized_content = fs::read_to_string(snapshot.source_path.join("src/review.ts"))
            .expect("read requested snapshot source");
        cleanup_snapshot(snapshot).expect("clean broker-owned snapshot");

        // Assert
        assert_eq!(snapshot_head, requested_head_sha);
        assert!(index_matches_requested_head.is_empty());
        assert_ne!(source_head_before_snapshot, requested_head_sha);
        assert_eq!(source_head_after_snapshot, source_head_before_snapshot);
        assert_eq!(materialized_content, "export const review = 'revision-a'\n");

        let _ = fs::remove_dir_all(repository_root);
    }

    #[cfg(unix)]
    #[test]
    fn full_history_snapshot_disables_hook_filter_and_fetch_config() {
        use std::os::unix::fs::PermissionsExt;

        // Arrange
        let _environment_lock = ENVIRONMENT_LOCK.lock().expect("lock test environment");
        let (repository_root, _) = scratch_repository();
        let activity_path = repository_root.join("unexpected-git-activity");
        let hooks_path = repository_root.join("hostile-hooks");
        let hook_path = hooks_path.join("post-checkout");
        let filter_path = repository_root.join("hostile-filter");
        let global_config_path = repository_root.join("hostile-global.gitconfig");
        fs::create_dir_all(&hooks_path).expect("create hostile hooks directory");
        fs::write(
            &hook_path,
            format!("#!/bin/sh\nprintf hook > {}\n", activity_path.display()),
        )
        .expect("write hostile hook");
        fs::write(
            &filter_path,
            format!(
                "#!/bin/sh\nprintf filter > {}\ncat\n",
                activity_path.display()
            ),
        )
        .expect("write hostile filter");
        fs::set_permissions(&hook_path, fs::Permissions::from_mode(0o700))
            .expect("make hostile hook executable");
        fs::set_permissions(&filter_path, fs::Permissions::from_mode(0o700))
            .expect("make hostile filter executable");
        fs::write(
            repository_root.join(".gitattributes"),
            "filtered.txt filter=hostile\n",
        )
        .expect("write hostile attributes");
        fs::write(
            repository_root.join("filtered.txt"),
            "review this exact blob\n",
        )
        .expect("write filtered source");
        git_in(&repository_root, &["add", ".gitattributes", "filtered.txt"]);
        git_in(
            &repository_root,
            &["commit", "--quiet", "-m", "add filtered source"],
        );
        let head_sha = git_in(&repository_root, &["rev-parse", "HEAD"]);
        fs::write(
            &global_config_path,
            format!(
                "[core]\n\thooksPath = {}\n[filter \"hostile\"]\n\tsmudge = {}\n\trequired = true\n[remote \"origin\"]\n\tpromisor = true\n\tpartialclonefilter = blob:none\n",
                hooks_path.display(),
                filter_path.display(),
            ),
        )
        .expect("write inherited hostile Git configuration");
        let _global_config =
            override_environment_variable("GIT_CONFIG_GLOBAL", &global_config_path);
        let request = AiSnapshotRequest {
            repository_root: repository_root.clone(),
            head_sha,
            policy: AiSnapshotPolicy {
                mode: AiSnapshotMode::FullGitHistory,
                custom_excluded_paths: vec![],
                max_file_bytes: 100,
            },
        };

        // Act
        let snapshot = prepare_snapshot(request).expect("prepare isolated full-history snapshot");
        let copied_content = fs::read_to_string(snapshot.source_path.join("filtered.txt"))
            .expect("read directly materialized source");
        let clone_config = fs::read_to_string(snapshot.source_path.join(".git/config"))
            .expect("read hardened clone config");
        let hostile_filter_is_unavailable = git_output(
            &repository_root,
            &["config", "--get", "filter.hostile.smudge"],
        )
        .is_err();
        let activity_is_absent = !activity_path.exists();
        cleanup_snapshot(snapshot).expect("clean broker-owned snapshot");

        // Assert
        assert_eq!(copied_content, "review this exact blob\n");
        assert!(
            activity_is_absent,
            "no inherited hook or filter may execute"
        );
        assert!(
            hostile_filter_is_unavailable,
            "isolated Git ignores inherited config"
        );
        assert!(clone_config.contains("hookspath = /dev/null"));
        assert!(clone_config.contains("smudge ="));
        assert!(clone_config.contains("process ="));
        assert!(clone_config.contains("promisor = false"));

        let _ = fs::remove_dir_all(repository_root);
    }
}
