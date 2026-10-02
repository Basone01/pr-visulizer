mod ai_broker;
mod ai_snapshot;
mod app_tool_mcp;
mod codex_answer;
mod codex_terminal;

pub fn run_render_mcp() -> Result<(), String> {
    app_tool_mcp::run_from_environment()
}

#[cfg(test)]
mod ai_broker_test_child;

use tauri::{Emitter, Manager};

// Deep-mode checkout reads (docs/tauri-architecture.md §6). The fs plugin's dialog-granted
// scope proved unreliable for subpaths of the picked clone root ("forbidden path" on
// <root>/<owner>/<repo>), so the two reads deep mode needs are custom commands with their own
// containment validation: the resolved path must stay inside the caller-supplied root after
// canonicalization, which also neutralizes `..` and symlink escapes.
fn contained_path(root: &str, relative: &str) -> Result<std::path::PathBuf, String> {
    let root = std::path::Path::new(root)
        .canonicalize()
        .map_err(|error| format!("clone root not accessible: {error}"))?;
    let joined = root.join(relative);
    let resolved = joined
        .canonicalize()
        .map_err(|error| format!("path not accessible: {error}"))?;

    if !resolved.starts_with(&root) {
        return Err("path escapes the clone root".into());
    }

    Ok(resolved)
}

#[tauri::command]
fn repo_path_exists(root: String, relative: String) -> bool {
    contained_path(&root, &relative).is_ok()
}

#[tauri::command]
fn repo_read_text(root: String, relative: String) -> Result<String, String> {
    let path = contained_path(&root, &relative)?;
    std::fs::read_to_string(&path).map_err(|error| format!("read failed: {error}"))
}

// ── Git object-DB reads at a revision (docs/tauri-architecture.md §6, linked repos) ─────
// Deep mode reads a linked repo AT THE PR HEAD SHA without ever touching the user's working
// tree: `ls-tree` lists the tree and `cat-file --batch` streams blob contents, both pure
// object-DB reads. They run from Rust `std::process` (not the webview shell plugin) because
// the batch output is byte-framed — `<size>` raw bytes after each header — and the plugin's
// line-based stdout events would mangle that framing. Byte-exact parsing needs Rust anyway,
// and it keeps the webview's shell capability surface unchanged.

// A revision this API accepts: a 4–40 hex object name, or FETCH_HEAD (right after the
// PR-head fetch). Anything else — branch names, `HEAD~1`, flag-shaped strings — is refused,
// which also guarantees the value can never be parsed as a git option.
fn validated_rev(rev: &str) -> Result<&str, String> {
    let is_hex_object =
        rev.len() >= 4 && rev.len() <= 40 && rev.chars().all(|c| c.is_ascii_hexdigit());
    if rev == "FETCH_HEAD" || is_hex_object {
        return Ok(rev);
    }

    Err(format!("invalid revision: {rev}"))
}

// The repo root must be an existing directory (canonicalized — also normalizes `..`).
fn validated_repo_root(root: &str) -> Result<std::path::PathBuf, String> {
    let resolved = std::path::Path::new(root)
        .canonicalize()
        .map_err(|error| format!("repo root not accessible: {error}"))?;
    if !resolved.is_dir() {
        return Err("repo root is not a directory".into());
    }

    Ok(resolved)
}

fn git_stdout(root: &std::path::Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|error| format!("failed to run git: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "git {} failed: {}",
            args.first().unwrap_or(&""),
            stderr.trim()
        ));
    }

    Ok(output.stdout)
}

// AI context reads must stop a local Git producer before its output becomes a webview string.
// Keep the cap at the broker's single-patch admission boundary; callers receive only a bounded
// omission, never a partially decoded patch.
const MAX_REPO_FILE_DIFF_BYTES: usize = 128 * 1024;

fn git_stdout_bounded(
    root: &std::path::Path,
    args: &[&str],
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    use std::io::Read;
    use std::process::Stdio;

    let mut child = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .stdout(Stdio::piped())
        // Git diagnostics are not context and must not create another unbounded pipe.
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("failed to run git: {error}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "git stdout was unavailable".to_string())?;
    let mut bytes = Vec::with_capacity(max_bytes.saturating_add(1));
    stdout
        .by_ref()
        .take((max_bytes.saturating_add(1)) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read git output: {error}"))?;

    if bytes.len() > max_bytes {
        let _ = child.kill();
        let _ = child.wait();
        return Err("git diff exceeded the bounded patch byte limit".into());
    }

    let status = child
        .wait()
        .map_err(|error| format!("failed to wait for git: {error}"))?;
    if !status.success() {
        return Err(format!("git {} failed", args.first().unwrap_or(&"")));
    }

    Ok(bytes)
}

// Every path in the tree at `rev` — repo-relative, no working-tree access. `-z`
// NUL-terminates entries so a filename containing a newline can't split into two phantom
// paths (and there is no quoting layer to undo).
#[tauri::command]
fn repo_list_at_rev(root: String, rev: String) -> Result<Vec<String>, String> {
    let root = validated_repo_root(&root)?;
    let rev = validated_rev(&rev)?;

    let stdout = git_stdout(&root, &["ls-tree", "-r", "--name-only", "-z", rev])?;
    let text = String::from_utf8_lossy(&stdout);
    Ok(text
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .map(|entry| entry.to_string())
        .collect())
}

// Read one `<size>`-framed cat-file --batch record body (+ the trailing LF git appends).
fn read_exact_body(reader: &mut impl std::io::BufRead, size: usize) -> Result<Vec<u8>, String> {
    let mut body = vec![0u8; size + 1]; // +1 for the record-terminating LF
    reader
        .read_exact(&mut body)
        .map_err(|error| format!("cat-file output truncated: {error}"))?;
    body.pop(); // drop the LF
    Ok(body)
}

// Batch-read many blobs at `rev` through ONE `git cat-file --batch` child. stdin gets one
// `<rev>:<path>` request per line; stdout answers each with `<sha> <type> <size>\n<size raw
// bytes>\n`, or `<request> missing\n` for a path absent at that revision. Missing paths and
// non-UTF-8 (binary) blobs map to None — the JS side treats both as "skip", mirroring the
// engine's defensive reader. stdin is written from a separate thread: git streams answers
// while requests are still being written, so a single-threaded write-all-then-read deadlocks
// once the stdout pipe buffer fills.
#[tauri::command]
fn repo_read_many_at_rev(
    root: String,
    rev: String,
    paths: Vec<String>,
) -> Result<Vec<(String, Option<String>)>, String> {
    use std::io::{BufRead, BufReader, Write};

    let root = validated_repo_root(&root)?;
    let rev = validated_rev(&rev)?.to_string();

    // A newline inside a path would smuggle a second request into the stream; paths come
    // from `ls-tree`, so this only fires on a hostile caller.
    if paths.iter().any(|path| path.contains('\n')) {
        return Err("paths must not contain newlines".into());
    }

    let mut child = std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["cat-file", "--batch"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to run git cat-file: {error}"))?;

    let mut stdin = child.stdin.take().ok_or("no stdin on git cat-file")?;
    let requests: Vec<String> = paths.iter().map(|path| format!("{rev}:{path}\n")).collect();
    let writer = std::thread::spawn(move || {
        for request in requests {
            if stdin.write_all(request.as_bytes()).is_err() {
                return; // reader side will surface the truncated stream
            }
        }
        // stdin drops here — EOF tells git the batch is complete.
    });

    let stdout = child.stdout.take().ok_or("no stdout on git cat-file")?;
    let mut reader = BufReader::new(stdout);
    let mut results: Vec<(String, Option<String>)> = Vec::with_capacity(paths.len());

    for path in &paths {
        let mut header = String::new();
        reader
            .read_line(&mut header)
            .map_err(|error| format!("cat-file read failed: {error}"))?;
        let header = header.trim_end();

        if header.is_empty() || header.ends_with(" missing") || header.ends_with(" ambiguous") {
            results.push((path.clone(), None));
            continue;
        }

        // `<sha> <type> <size>` — the size field frames the raw body that follows.
        let size = header
            .rsplit(' ')
            .next()
            .and_then(|field| field.parse::<usize>().ok())
            .ok_or_else(|| format!("unexpected cat-file header: {header}"))?;

        let body = read_exact_body(&mut reader, size)?;
        results.push((path.clone(), String::from_utf8(body).ok()));
    }

    writer
        .join()
        .map_err(|_| "stdin writer panicked".to_string())?;
    let status = child
        .wait()
        .map_err(|error| format!("git cat-file: {error}"))?;
    if !status.success() {
        return Err("git cat-file exited with an error".into());
    }

    Ok(results)
}

// The `origin` remote URL of a local repo — the desktop derives `{owner, repo}` from it to
// validate a user-linked folder against the PR's repo. A Rust command (not a webview shell
// capability entry) so ALL git introspection shares one trust boundary with the reads above.
#[tauri::command]
fn repo_origin_url(root: String) -> Result<String, String> {
    let root = validated_repo_root(&root)?;
    let stdout = git_stdout(&root, &["remote", "get-url", "origin"])?;
    Ok(String::from_utf8_lossy(&stdout).trim().to_string())
}

// ── Local PR diff (docs/tauri-architecture.md §6) ───────────────────────────────────────
// Deep mode computes the PR's changed-file list AND per-file patches from LOCAL git instead
// of the GitHub API's paginated listFiles-with-patches (multi-second on 100+-file PRs). Both
// use the three-dot `base...head` range — `merge-base(base, head)..head` — which is exactly
// GitHub's PR-file semantics (what changed on the branch, ignoring base-branch commits since
// the fork point). Both revs go through the same `validated_rev` gate as the object-DB reads.

#[derive(serde::Serialize)]
struct ChangedFileEntry {
    path: String,
    status: String, // "added" | "modified" | "deleted" | "renamed"
    additions: u32,
    deletions: u32,
}

// `base...head` for a git range arg. Both revs are already `validated_rev`-checked, so the
// composed string can never be parsed as a flag or smuggle a second argument.
fn three_dot_range(base: &str, head: &str) -> String {
    format!("{base}...{head}")
}

// Histogram pairs/groups changed lines far more readably than the default myers — on this
// codebase myers tears added blocks across unrelated `})` context lines (owner-reviewed
// comparison, 2026-07). Same +/- totals, only the grouping differs; name-status/numstat
// are unaffected but get the flag too so every diff view agrees on hunk boundaries.
const DIFF_ALGORITHM: &str = "--diff-algorithm=histogram";

// Map a git status letter to our contract's vocabulary (added/modified/deleted/renamed).
// Copies (C, only with --find-copies which we don't pass) fold into "added" (a new file);
// type-changes (T) and anything unknown fold into "modified".
fn status_word(letter: char) -> &'static str {
    match letter {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "added",
        _ => "modified",
    }
}

// Parse `git diff --name-status --find-renames -z` into (path, status). A NUL stream: A/M/D
// entries are `<status>\0<path>\0`, renames are `<status>\0<old>\0<new>\0` (the NEW path is
// the current one). Order is git's diff order (path-sorted), preserved for the caller.
fn parse_name_status(stdout: &[u8]) -> Vec<(String, String)> {
    let text = String::from_utf8_lossy(stdout);
    let mut tokens = text.split('\0');
    let mut out: Vec<(String, String)> = Vec::new();

    while let Some(status) = tokens.next() {
        let Some(letter) = status.chars().next() else {
            continue;
        };

        // A rename/copy spends an extra token on the old path; the new path is what we key on.
        let path = if letter == 'R' || letter == 'C' {
            let _old = tokens.next();
            tokens.next().unwrap_or("")
        } else {
            tokens.next().unwrap_or("")
        };

        if !path.is_empty() {
            out.push((path.to_string(), status_word(letter).to_string()));
        }
    }

    out
}

// Parse `git diff --numstat --find-renames -z` into path → (additions, deletions). A NUL
// stream where each record is `<add>\t<del>\t<path>`, except renames put an EMPTY path there
// and follow with `\0<old>\0<new>`. Binary files report `-` for both counts → 0.
fn parse_numstat(stdout: &[u8]) -> std::collections::HashMap<String, (u32, u32)> {
    let text = String::from_utf8_lossy(stdout);
    let mut tokens = text.split('\0');
    let mut counts = std::collections::HashMap::new();

    while let Some(entry) = tokens.next() {
        if entry.is_empty() {
            continue;
        }

        let mut fields = entry.splitn(3, '\t');
        let additions = fields.next().unwrap_or("0").parse::<u32>().unwrap_or(0);
        let deletions = fields.next().unwrap_or("0").parse::<u32>().unwrap_or(0);
        let rest = fields.next().unwrap_or("");

        let path = if rest.is_empty() {
            let _old = tokens.next();
            tokens.next().unwrap_or("")
        } else {
            rest
        };

        if !path.is_empty() {
            counts.insert(path.to_string(), (additions, deletions));
        }
    }

    counts
}

// The PR's changed files with churn — `git diff --name-status` for the status vocabulary and
// `git diff --numstat` for the line counts, merged by path. Two cheap `-z` passes (NUL-framed
// so a newline in a filename can't split a record), both over `base...head`.
#[tauri::command]
fn repo_changed_files(
    root: String,
    base_rev: String,
    head_rev: String,
) -> Result<Vec<ChangedFileEntry>, String> {
    let root = validated_repo_root(&root)?;
    let base = validated_rev(&base_rev)?;
    let head = validated_rev(&head_rev)?;
    let range = three_dot_range(base, head);

    let name_status = git_stdout(
        &root,
        &[
            "diff",
            DIFF_ALGORITHM,
            "--name-status",
            "--find-renames",
            "-z",
            &range,
        ],
    )?;
    let numstat = git_stdout(
        &root,
        &[
            "diff",
            DIFF_ALGORITHM,
            "--numstat",
            "--find-renames",
            "-z",
            &range,
        ],
    )?;

    let counts = parse_numstat(&numstat);
    let files = parse_name_status(&name_status)
        .into_iter()
        .map(|(path, status)| {
            let (additions, deletions) = counts.get(&path).copied().unwrap_or((0, 0));
            ChangedFileEntry {
                path,
                status,
                additions,
                deletions,
            }
        })
        .collect();

    Ok(files)
}

// One file's unified-diff patch, computed locally over `base...head`. `--` fences the path so
// a `-`-leading filename can't be read as a flag; an unchanged path yields an empty string.
#[tauri::command]
fn repo_file_diff(
    root: String,
    base_rev: String,
    head_rev: String,
    path: String,
) -> Result<String, String> {
    let root = validated_repo_root(&root)?;
    let base = validated_rev(&base_rev)?;
    let head = validated_rev(&head_rev)?;

    if path.is_empty() || path.contains('\n') {
        return Err("invalid path".into());
    }

    let range = three_dot_range(base, head);
    let stdout = git_stdout_bounded(
        &root,
        &["diff", DIFF_ALGORITHM, &range, "--", &path],
        MAX_REPO_FILE_DIFF_BYTES,
    )?;
    String::from_utf8(stdout).map_err(|_| "git diff was not valid UTF-8".into())
}

// Protocol tests for the object-DB reads: a scratch git repo (never this project's repo)
// proves the ls-tree listing and the byte-exact cat-file --batch parsing — including the
// missing-path and binary-blob → None mappings — against a real git.
#[cfg(test)]
mod tests {
    use super::*;

    fn git_in(dir: &std::path::Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn scratch_repo() -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("prv-batch-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).expect("mkdir");

        std::fs::write(dir.join("src/a.ts"), "export const a = 1\n").expect("write");
        // Multi-line body exercises the size framing (an LF inside the blob must not
        // terminate the record early).
        std::fs::write(dir.join("src/b.ts"), "line1\nline2\nline3\n").expect("write");
        std::fs::write(dir.join("bin.dat"), [0u8, 159, 146, 150]).expect("write"); // invalid UTF-8

        git_in(&dir, &["init", "-q"]);
        git_in(&dir, &["add", "."]);
        git_in(&dir, &["commit", "-q", "-m", "seed"]);
        let sha = git_in(&dir, &["rev-parse", "HEAD"]);
        (dir, sha)
    }

    #[test]
    fn lists_and_batch_reads_at_a_rev() {
        let (dir, sha) = scratch_repo();
        let root = dir.to_string_lossy().to_string();

        let listed = repo_list_at_rev(root.clone(), sha.clone()).expect("list");
        assert_eq!(listed, vec!["bin.dat", "src/a.ts", "src/b.ts"]);

        let paths = vec![
            "src/a.ts".to_string(),
            "src/b.ts".to_string(),
            "bin.dat".to_string(),
            "src/gone.ts".to_string(),
        ];
        let reads = repo_read_many_at_rev(root, sha, paths).expect("batch read");

        assert_eq!(
            reads[0],
            ("src/a.ts".into(), Some("export const a = 1\n".into()))
        );
        assert_eq!(
            reads[1],
            ("src/b.ts".into(), Some("line1\nline2\nline3\n".into()))
        );
        assert_eq!(reads[2], ("bin.dat".into(), None)); // binary → None
        assert_eq!(reads[3], ("src/gone.ts".into(), None)); // missing → None

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_a_non_object_revision() {
        assert!(validated_rev("FETCH_HEAD").is_ok());
        assert!(validated_rev("3f9c2e1a").is_ok());
        assert!(validated_rev("main").is_err());
        assert!(validated_rev("HEAD~1").is_err());
        assert!(validated_rev("--upload-pack=evil").is_err());
    }

    // A scratch repo with a base commit then a head commit that adds, modifies and deletes a
    // file — the three statuses the local PR diff must report, computed over `base...head`.
    fn scratch_diff_repo(tag: &str) -> (std::path::PathBuf, String, String) {
        // Tag the dir per test: cargo runs tests in parallel, and same-pid siblings would
        // otherwise clobber one shared path.
        let dir = std::env::temp_dir().join(format!("prv-diff-test-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");

        git_in(&dir, &["init", "-q"]);
        std::fs::write(dir.join("a.txt"), "a\n").expect("write");
        std::fs::write(dir.join("b.txt"), "keep\n").expect("write");
        git_in(&dir, &["add", "."]);
        git_in(&dir, &["commit", "-q", "-m", "base"]);
        let base_sha = git_in(&dir, &["rev-parse", "HEAD"]);

        std::fs::write(dir.join("a.txt"), "a\nb\n").expect("write"); // modified: +1 line
        std::fs::remove_file(dir.join("b.txt")).expect("rm"); // deleted
        std::fs::write(dir.join("c.txt"), "new\n").expect("write"); // added
        git_in(&dir, &["add", "-A"]);
        git_in(&dir, &["commit", "-q", "-m", "head"]);
        let head_sha = git_in(&dir, &["rev-parse", "HEAD"]);

        (dir, base_sha, head_sha)
    }

    #[test]
    fn lists_changed_files_with_status_and_churn() {
        // Arrange
        let (dir, base_sha, head_sha) = scratch_diff_repo("list");
        let root = dir.to_string_lossy().to_string();

        // Act
        let changed = repo_changed_files(root, base_sha, head_sha).expect("changed files");

        // Assert — name-status order is path-sorted: a.txt, b.txt, c.txt.
        let expected: Vec<(&str, &str, u32, u32)> = vec![
            ("a.txt", "modified", 1, 0),
            ("b.txt", "deleted", 0, 1),
            ("c.txt", "added", 1, 0),
        ];
        let actual: Vec<(&str, &str, u32, u32)> = changed
            .iter()
            .map(|f| (f.path.as_str(), f.status.as_str(), f.additions, f.deletions))
            .collect();
        assert_eq!(actual, expected);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_one_files_local_patch() {
        // Arrange
        let (dir, base_sha, head_sha) = scratch_diff_repo("patch");
        let root = dir.to_string_lossy().to_string();
        let path = "a.txt".to_string();

        // Act
        let patch = repo_file_diff(root, base_sha, head_sha, path).expect("file diff");

        // Assert — a real unified diff for a.txt with the added line, and nothing about c.txt.
        assert!(patch.contains("@@"), "expected a hunk header in: {patch}");
        assert!(patch.contains("+b"), "expected the added line in: {patch}");
        assert!(
            !patch.contains("c.txt"),
            "diff must be scoped to a.txt: {patch}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn repo_file_diff_enforces_byte_cap_before_utf8_conversion() {
        // Arrange
        let (dir, base_sha, _head_sha) = scratch_diff_repo("bounded-patch");
        let oversized = "x\n".repeat(MAX_REPO_FILE_DIFF_BYTES);
        std::fs::write(dir.join("a.txt"), oversized).expect("write oversized patch");
        git_in(&dir, &["add", "a.txt"]);
        git_in(&dir, &["commit", "-q", "-m", "oversized patch"]);
        let head_sha = git_in(&dir, &["rev-parse", "HEAD"]);

        // Act
        let result = repo_file_diff(
            dir.to_string_lossy().to_string(),
            base_sha,
            head_sha,
            "a.txt".to_string(),
        );

        // Assert — no oversized Git bytes reach lossy/string conversion in the command boundary.
        assert_eq!(
            result.expect_err("oversized output must be omitted"),
            "git diff exceeded the bounded patch byte limit"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// The whole desktop shell (docs/tauri-architecture.md §5): register the official plugins and
// let the webview do the rest. Custom Rust stays minimal — the single-instance callback plus
// the two validated checkout-read commands above.
// Finder-launched GUI apps get a minimal PATH (/usr/bin:/bin:…) that misses Homebrew's
// /opt/homebrew/bin — so the shell plugin can't find `gh` in the installed app even though
// it works in `tauri dev` (which inherits a real shell). Ask the user's login shell for its
// PATH once at startup and adopt it — the same technique as tauri-apps/fix-path-env, inlined
// so the dependency surface stays zero. Marker-delimited so rc-file noise can't corrupt it.
#[cfg(target_os = "macos")]
fn adopt_login_shell_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = std::process::Command::new(&shell)
        .args(["-lc", "printf '__PATH__%s__PATH__' \"$PATH\""])
        .output();

    let Ok(output) = output else { return };
    if !output.status.success() {
        return;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let Some(start) = stdout.find("__PATH__") else {
        return;
    };
    let rest = &stdout[start + "__PATH__".len()..];
    let Some(end) = rest.find("__PATH__") else {
        return;
    };

    let path = &rest[..end];
    if !path.is_empty() {
        std::env::set_var("PATH", path);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    adopt_login_shell_path();

    let mut builder = tauri::Builder::default()
        .manage(ai_broker::CodexSafeProfileBroker::capture_adopted_login_shell_path())
        .manage(ai_broker::CodexSafeProfileActiveRuns::default())
        .manage(ai_broker::CodexSafeProfileStartupRecovery::default())
        .manage(codex_terminal::CodexTerminalSessions::default())
        .manage(codex_answer::CodexAnswerSessions::default())
        // A browser reload discards the terminal listeners, so end any PTY owned by the prior
        // document before the replacement UI starts listening.
        .on_page_load(|webview, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Started
                || webview.label() != "main"
            {
                return;
            }

            if let Some(terminal_sessions) =
                webview.try_state::<codex_terminal::CodexTerminalSessions>()
            {
                terminal_sessions.shutdown();
            }
        });

    // Single Instance must be registered FIRST (plugin ordering requirement). A second
    // `pr-visualizer <url>` focuses the open window and hands it the argv; the webview parses
    // the URL and navigates (docs/tauri-architecture.md §6).
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.emit("single-instance", argv);
            }
        }));
    }

    let app = builder
        .invoke_handler(tauri::generate_handler![
            repo_path_exists,
            repo_read_text,
            repo_list_at_rev,
            repo_read_many_at_rev,
            repo_origin_url,
            ai_broker::codex_safe_profile_capability,
            ai_broker::codex_safe_profile_safely_recovered_run_ids,
            ai_broker::codex_safe_profile_acknowledge_recovered_runs,
            ai_broker::codex_safe_profile_start,
            ai_broker::codex_safe_profile_cancel,
            codex_terminal::codex_terminal_start,
            codex_terminal::codex_terminal_attach,
            codex_terminal::codex_terminal_write,
            codex_terminal::codex_terminal_resize,
            codex_terminal::codex_terminal_stop,
            codex_answer::codex_terminal_update_context,
            codex_answer::codex_answer_window_state,
            codex_answer::codex_answer_window_open_file,
            repo_changed_files,
            repo_file_diff
        ])
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        // Deep mode (docs/tauri-architecture.md §6): the folder picker + filesystem reads of the
        // checkout. `persisted-scope` MUST come AFTER `fs` so it can save the dialog-granted fs
        // scope — registering it before `fs` makes it a no-op and warns in dev.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        // This runs before the webview starts. Rust alone inspects the app-data root, validates
        // marker-bound PID/start evidence, and either terminates/waits owned live work or leaves
        // unresolved state untouched. The webview can later read only safely resolved opaque IDs.
        .setup(|app| {
            let app_owned_root = app.path().app_data_dir()?;
            let safely_resolved_run_ids =
                ai_broker::recover_codex_safe_profile_transients(&app_owned_root)
                    .map_err(std::io::Error::other)?;
            app.state::<ai_broker::CodexSafeProfileStartupRecovery>()
                .replace_safely_resolved_run_ids(safely_resolved_run_ids);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Tauri application");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            if let Some(active_runs) =
                app_handle.try_state::<ai_broker::CodexSafeProfileActiveRuns>()
            {
                let _ = active_runs.shutdown();
            }
            if let Some(terminal_sessions) =
                app_handle.try_state::<codex_terminal::CodexTerminalSessions>()
            {
                terminal_sessions.shutdown();
            }
            if let Some(answer_sessions) =
                app_handle.try_state::<codex_answer::CodexAnswerSessions>()
            {
                answer_sessions.shutdown();
            }
        }
    });
}
