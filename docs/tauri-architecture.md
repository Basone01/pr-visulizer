# Tauri Desktop Mode — Architecture

`pr-visualizer <github-pr-url>` as a desktop app: no server process, no OAuth, GitHub auth borrowed from the `gh` CLI you already trust.

Written for a junior engineer who knows the existing codebase docs (`docs/architecture.md`).
Section references like §5 point into that document.

---

## 1. The idea in one paragraph

Today the app is a browser SPA talking to a local Fastify BFF, and the BFF exists for two reasons: it holds the GitHub token (OAuth) and it runs the tree-sitter analysis.
A desktop shell dissolves both reasons.
The token comes from `gh auth token` — the GitHub CLI already stores and refreshes credentials, so OAuth infrastructure becomes unnecessary.
The analysis engine is already WASM-based (`web-tree-sitter`), so it can run inside the webview itself.
What remains is packaging: a Tauri 2 window around the existing SPA, with the engine moved into a shared package so the BFF keeps working for the hosted-web deployment.

**Tauri is a second shell over existing seams — not a rewrite.**

---

## 2. Before / after package tree

```
BEFORE                              AFTER
──────────────────────────         ──────────────────────────
packages/shared                    packages/shared        (unchanged: contract + ranking)
  contract + ranking               packages/engine        ← NEW (extracted, not rewritten)
apps/server                          FastAstEngine, treeSitter, heuristic,
  routes, auth, progress store       gateway interface + Octokit impl + fake,
  githubGateway/  ─┐                 cache, diffHunks/modulePath/language utils
  analysis/       ─┴─ MOVES        apps/server            (kept: thin BFF shell)
apps/web                             routes, auth, progress store — consumes engine
  SPA, PrClient seam               apps/web               (unchanged seams, +1 client)
                                     service/tauri/tauriPrClient  ← NEW
                                   apps/desktop           ← NEW (Tauri 2 shell)
                                     src-tauri/ (Rust, ~no custom code)
```

Dependency direction stays clean: `desktop → web → engine → shared`, `server → engine → shared`.

---

## 3. Why this is nearly free: the three seams

The original architecture already isolated everything that varies.
Each seam below exists today (file paths are current, verified):

### Seam 1 — `PrClient` (the web data boundary)

`apps/web/src/service/prClient.ts` defines the six-method interface the entire SPA depends on; `clientFactory.ts` picks the implementation (`http` vs `fixture`) in one place.
Tauri mode is a **third implementation**, not a new pattern:

```ts
client = env.tauriMode
  ? createTauriPrClient()
  : env.fixtureMode
    ? createFixturePrClient()
    : createHttpPrClient()
```

No component, hook, or query changes — they never knew about HTTP to begin with.

### Seam 2 — `GithubGateway` (the GitHub boundary)

`apps/server/src/services/githubGateway/gateway.ts` is already an interface with two implementations (Octokit, fixture fake).
The engine only ever sees the interface.
Octokit runs in browsers; the only webview problem is CORS — solved by Tauri's official **HTTP Client plugin** (a Rust-side client, so webview CORS rules don't apply).
Octokit accepts an injected `fetch` (`new Octokit({ request: { fetch } })`), so the same Octokit gateway works in the webview with the plugin's fetch passed in.

### Seam 3 — the grammar loader (the ONLY real refactor)

`apps/server/src/services/analysis/treeSitter.ts` is the single module touching tree-sitter, but it is node-coupled in exactly one spot:

```ts
const wasmPath = requireFromHere.resolve(`tree-sitter-wasms/out/tree-sitter-${grammarId}.wasm`)
return Language.load(wasmPath)
```

`createRequire` and filesystem paths do not exist in a webview.
The fix is a **grammar-source seam** — the engine takes a loader as a setting (controllable core, `AGENTS.architecture.md` style):

```ts
// packages/engine — platform-neutral
export type GrammarSource = (grammarId: string) => Promise<Uint8Array>

// node (BFF): resolve from tree-sitter-wasms and read the file
// webview (Tauri + hosted web): fetch a bundled asset URL
const wasmUrl = new URL(`../grammars/tree-sitter-${grammarId}.wasm`, import.meta.url)
```

`web-tree-sitter`'s `Language.load` accepts bytes as well as a path, and `Parser.init` accepts a `locateFile` hook for its own core wasm — both loaders inject cleanly.
Everything else in `treeSitter.ts` (symbol/import/reference extraction) is already plain data-out and moves untouched.

---

## 4. `packages/engine` — what moves, verbatim

From `apps/server/src`:

| Moves                                                        | Why it's portable                         |
| ------------------------------------------------------------ | ----------------------------------------- |
| `services/analysis/fastEngine.ts`                            | pure data flow; deps injected             |
| `services/analysis/treeSitter.ts`                            | after the grammar-source seam (§3)        |
| `services/analysis/heuristic.ts`, `cache.ts`, `engine.ts`    | pure / tiny                               |
| `services/githubGateway/gateway.ts` (interface + types)      | types only                                |
| `services/githubGateway/octokitGateway.ts`                   | gains optional `fetch` param              |
| `services/githubGateway/fakeGateway.ts` + `fixtures/pr42.ts` | pure; web fixture mode can reuse it later |
| `utils/diffHunks.ts`, `modulePath.ts`, `language.ts`         | pure                                      |

Stays in `apps/server`: routes, auth, env config, SQLite progress store, review-submit service (the BFF's own composition).
The BFF's imports change from relative paths to `@pr-visulizer/engine` — its 9 integration tests keep guarding the engine exactly as before, which is the main argument for extraction over duplication.

---

## 5. `apps/desktop` — the Tauri 2 shell

Official plugins only (verified against the Tauri 2 plugin registry); custom Rust ≈ zero:

| Plugin              | Used for                                                 |
| ------------------- | -------------------------------------------------------- |
| **Shell**           | run `gh auth token` (scoped to exactly that command)     |
| **CLI**             | parse `pr-visualizer <url>` arguments                    |
| **Single Instance** | second invocation forwards its URL to the running window |
| **Store**           | review progress as a local JSON store                    |
| **HTTP Client**     | CORS-free `fetch` for the Octokit gateway                |

### Install vs CLI — both, same binary

`pnpm desktop:build` produces the signed and notarized macOS release (`.app`/`.dmg`).
Release verification must pass before the DMG is copied to iCloud.
See [desktop releases](desktop-releases.md) for the required workflow.
Double-clicking it from Applications/Dock opens the home screen — the terminal is never required.
The CLI is an _optional accelerator_ over the same binary: `pr-visualizer` on PATH is a tiny shim that execs the installed app's executable with your args, and the Single Instance plugin makes a CLI invocation focus the already-running window instead of spawning a second app.

| How you launch                 | Where you land                                                       |
| ------------------------------ | -------------------------------------------------------------------- |
| double-click the installed app | home screen                                                          |
| `pr-visualizer` (no args)      | home screen                                                          |
| `pr-visualizer <pr-url>`       | that PR's review screen (forwarded to the open window if one exists) |

### Startup flow — three entry paths, one review screen

```
ENTRY A — CLI arg          ENTRY B — plain open        ENTRY C — my repos
pr-visualizer <pr-url>     open the app                open the app
  │                          │                           │
  │ CLI plugin parses        ▼                           ▼
  │ the target            ┌──────────── HOME SCREEN ────────────┐
  │                       │  Paste a PR URL: [____________] Go  │
  │                       │  My repos      [+ add local repo]   │
  │                       │    web  acme/web  ~/src/web         │
  │                       │      #42 Add login rate limiting →  │
  │                       │      #40 Fix session refresh     →  │
  │                       │    mobile  acme/mobile  ~/src/mob…  │
  │                       └──────────────┬──────────────────────┘
  │                                      │ pick / paste → target
  ▼                                      ▼
  ────────────────── REVIEW SCREEN (target = {owner, repo, number}) ───────
  Shell plugin ran `gh auth token` once at startup (memory only)
  TauriPrClient.getAnalysis() → deep pipeline, automatically (§6): overview shell instantly →
  RepoSource prepare (linked repo preferred) → batch object-DB reads → pure deep core in a
  Web Worker → complete graph. Engine badge: always DEEP · REPO.
```

Common steps for every path: Single Instance first (a second invocation forwards its args to the running window), `gh auth token` once at startup.
Accepted URL forms: full URL, `owner/repo#42`, `owner/repo/42`.
No token exchange, no callback URL, no session cookie — the auth service is one shell command.

### The home screen (entry B and C) — "My repos", repo-first

- **URL input** — parse-as-you-type; a valid target enables "Go". Invalid input shows the three accepted forms inline (no separate error screen). A pasted PR whose repo is linked reads from that clone; an unlinked one lands on the review screen's locate-vs-clone prompt — the home screen never special-cases it.
- **My repos** — the user's LINKED LOCAL REPOS (`{ path, owner, repo }[]`, persisted through the app storage under `repoLinks`). "+ Add local repo" opens the folder picker; the slug is derived by parsing the clone's `origin` remote (ssh `git@github.com:owner/repo.git` and `https://github.com/owner/repo(.git)` forms; not-a-repo / non-GitHub origin render as inline errors). Each card shows the repo name, slug, local path, and its **open PRs** (number, title, author, updated-at; newest-updated first) via `listOpenPullRequests`, plus refresh and remove-link.
- Fetch-on-open, manual refresh button — no background polling in this slice.
- The old slug-only watched-repos list is REPLACED by this (pre-release, no migration). Browser mode renders the same screen read-only (linking needs the desktop's folder picker + git).

Two small contract additions flow through the stack:

```ts
// packages/shared — PR list item for the picker
type PrSummary = { number: number; title: string; author: string; updatedAt: string }

// packages/engine — gateway interface gains:
listOpenPullRequests(repo: { owner: string; repo: string }): Promise<PrSummary[]>
// (GET /repos/:owner/:repo/pulls?state=open — one Octokit call)

// apps/web — PrClient gains:
listOpenPullRequests(repo): Promise<PrSummary[]>   // tauri: gateway direct · http: new BFF route
```

Routing note: today `App.tsx` reads the target from URL params once at mount.
The home screen turns that into explicit app state — `{ screen: "home" } | { screen: "review", target }` — with URL params (and CLI args) as initializers for deep-linking, and a back-to-home control in the top bar.
Repo-link management (add/remove) stays client-side state + app storage; the schema is `{ path, owner, repo }[]` under the `repoLinks` key, parse-don't-trusted on read.

### Error UX (explicit, not an afterthought)

| Condition                  | Behavior                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `gh` not installed         | full-window message: "Install GitHub CLI: `brew install gh`", retry button                  |
| `gh` installed, not authed | "Run `gh auth login`, then retry"                                                           |
| pasted URL doesn't parse   | inline under the input: the three accepted forms                                            |
| CLI arg doesn't parse      | open on the home screen with the arg prefilled + the same inline hint                       |
| token lacks repo access    | surface GitHub's 404/403 with the repo name (also shown per linked repo that fails to list) |

---

## 6. `TauriPrClient` — method by method

The `PrClient` interface, mapped to in-webview implementations:

| Method                        | Implementation                                                                                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getAnalysis(target, _)`      | DEEP-ONLY: run the full deep pipeline automatically (the requested engine is ignored — owner decision; fast remains the BFF/browser path). See "Deep-only desktop" below. Returns `{ status: "ready", result }`; every phase feeds `subscribeAnalysisProgress`                  |
| `getOverview(target)`         | light PR meta (`getPullMeta` — one `pulls.get`) + the changed-file list from LOCAL git (`repo_changed_files`). No patches, renders instantly. Empty file list when no repo is linked yet, so the shell still renders and the analysis query surfaces the locate-vs-clone prompt |
| `getPatch(target, path)`      | the file's patch computed LOCALLY over `base...head` (`repo_file_diff`), lazy per file. Falls back to the API patch (`getPullRequest`) only when no repo is linked or the base object couldn't be fetched                                                                       |
| `getProgress` / `putProgress` | Store plugin JSON file, keyed `${owner}/${repo}#${number}@${headSha}`, parsed through the shared `reviewProgressSchema` on read (parse-don't-trust survives the platform change)                                                                                                |
| `submitReview`                | gateway → `POST /pulls/:n/reviews` (same Octokit call the BFF makes)                                                                                                                                                                                                            |
| `listOpenPullRequests`        | gateway → `GET /repos/:o/:r/pulls?state=open` (the home screen's picker; browser mode goes through a new BFF route)                                                                                                                                                             |

The engine's LRU cache keyed by `(headSha, engine)` moves with it, so re-opening the same PR re-renders instantly without refetching.

### Deep-only desktop — RepoSource, linked repos, and the analysis worker

The desktop no longer has a fast mode or a "Deepen analysis" button (owner decision: fast's per-file graph is near-empty; once reads are local, deep IS the analysis). Opening a PR runs the full deep pipeline automatically:

```
getAnalysis(target)
  1. fetching-pr      gateway.getPullMeta — LIGHT PR meta only (one `pulls.get`, no file
                      pagination); the changed-file list + patches + contents all come from git
  2. preparing-repo   RepoSource.prepare — fetch PR head + base object (linked) or
                      clone/fetch/checkout + base object (managed); git progress lines stream in
  3. reading-files    listFiles at headSha → engine's scanCandidatePaths filter →
                      repo_read_many_at_rev in ~400-path chunks (progress per chunk).
                      The changed-file set + its patches come from repo_changed_files +
                      repo_file_diff (base...head) — modified/renamed files get a local patch so
                      the deep engine can map head hunks to the changed symbols
  4. parsing/resolving/ranking
                      the PURE deep core (packages/engine `analyzeDeepFromSources`) inside a
                      Web Worker — the webview never blocks, counters stream back live
  5. cache            immutable per headSha; re-open renders instantly
```

**`RepoSource` seam** (`apps/web/src/tauri/repoSource.ts`) — `prepare(target, headSha, onProgress) → { listFiles, readFile, readMany }`, all reads pinned AT THE SHA from the git object DB, never a working tree:

- **`LinkedRepoSource` (preferred)** — the user's EXISTING clone, registered in the repo-link registry (`{ path, owner, repo }[]` in app storage). `git -C <path> fetch origin pull/<n>/head` writes objects + FETCH_HEAD and NOTHING else — no checkout, the user's worktree/branches/index are provably untouched. Reads then pin to the head SHA itself (not FETCH_HEAD, which any later fetch overwrites). A second `git fetch origin <baseSha>` ensures the PR's base commit is present so the `base...head` diff resolves (a fast no-op if already local); a failure — e.g. a server that won't serve an unadvertised SHA — is non-fatal and flips the client to the API patch for that PR (`baseReady=false`).
- **`ManagedCloneSource` (fallback)** — wraps the existing clone manager (`<cloneRoot>/<owner>/<repo>`, clone + fetch + forced detached checkout — it is our cache dir). Reads go through the same object-DB commands for the same batch speed.
- **Selection**: linked repo for the PR's owner/repo if registered → else managed clone if a clone root is set → else `getAnalysis` rejects with the typed `NeedsRepoSourceError` and the review screen renders the inline prompt: **"Locate local clone…"** (folder picker → origin must match the PR's owner/repo → registers the link) with **"Clone it for me"** as the fallback (opens the clone-root picker if unset, then the managed path).

**The analysis Web Worker** (`apps/web/src/workers/`) — tree-sitter parsing of a whole repo on the main thread froze the webview on 100+-file PRs. The CPU pipeline is now the engine's pure `analyzeDeepFromSources` core running in a `new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" })`. Tauri plugin APIs and `window.__TAURI_INTERNALS__` do NOT exist inside workers, so the MAIN thread does all I/O and posts plain-object sources; the worker fetches the bundled grammar wasms itself (`?url` assets, plain same-origin fetch works in workers). Protocol: `{ type: "analyze", pr, files, contents }` in; `{ type: "progress" | "result" | "error" }` out; the worker is terminated after each run so its repo-sized memory is reclaimed.

**Rust commands** (`apps/desktop/src-tauri/src/lib.rs`) — all validated in Rust; `rev` must match `^[0-9a-fA-F]{4,40}$|FETCH_HEAD`, `root` must canonicalize to an existing directory:

| Command                                   | What it runs                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo_path_exists(root, relative)`        | containment-checked `fs` probe (managed-clone state detection)                                                                                                                                                                                                                                                                                 |
| `repo_read_text(root, relative)`          | containment-checked single-file read (legacy managed path)                                                                                                                                                                                                                                                                                     |
| `repo_list_at_rev(root, rev)`             | `git -C root ls-tree -r --name-only -z <rev>` → `Vec<String>` (NUL-framed, newline-safe)                                                                                                                                                                                                                                                       |
| `repo_read_many_at_rev(root, rev, paths)` | ONE `git cat-file --batch` child per call: writes `<rev>:<path>` requests to stdin (from a separate thread — write-all-then-read deadlocks once the pipe fills), parses the byte-exact output (`<sha> <type> <size>` header, then `size` raw bytes + LF; `<obj> missing` → `None`; non-UTF-8/binary → `None`). JS chunks ~400 paths per invoke |
| `repo_origin_url(root)`                   | `git -C root remote get-url origin` → the slug source for linking                                                                                                                                                                                                                                                                              |
| `repo_changed_files(root, base, head)`    | the PR's changed-file list with churn — `git diff --name-status --find-renames -z base...head` (status vocabulary A/M/D/R → added/modified/deleted/renamed) merged by path with `git diff --numstat --find-renames -z base...head` (line counts; binary `-` → 0). Two cheap `-z` passes; three-dot range = GitHub's PR-file semantics          |
| `repo_file_diff(root, base, head, path)`  | one file's unified-diff patch, `git diff base...head -- <path>` (`--` fences the path against flag injection); empty string if unchanged. The lazy per-file diff view + the analysis's changed-symbol hunks                                                                                                                                    |

Why Rust `std::process` and not the webview shell plugin: `cat-file --batch` output is BYTE-framed (`size` raw bytes after each header) and the shell plugin's line-based stdout events would mangle that framing; running all git introspection (incl. the origin lookup) from Rust also keeps the webview's shell capability surface unchanged. Capabilities gate the WEBVIEW's shell plugin only — Rust commands need none. The webview-spawned set stays: `gh auth token`, `gh repo clone`, `git fetch origin pull/<n>/head` (reused by LinkedRepoSource — streamed progress lines are line-shaped, so the plugin fits there), `git fetch origin <baseSha>` (the base-object fetch, capability `git-fetch-object`, sha-validated), `git checkout --force --detach FETCH_HEAD`, `git ls-files`. The local PR diff itself (`repo_changed_files` / `repo_file_diff`) runs from Rust like the other object-DB reads, not the shell plugin.

**Folder-picker ↔ fs-scope note (verified against the Tauri 2 docs, 2026-07).** A directory chosen through the Dialog `open()` picker is **automatically added to the fs plugin's runtime scope**; `tauri-plugin-persisted-scope` (registered **after** `fs`) persists that grant. In practice the object-DB reads bypass fs-scope entirely (Rust commands do their own validation), so the scope only matters for the legacy probes. Sources: [File System](https://v2.tauri.app/plugin/file-system/), [Persisted Scope](https://v2.tauri.app/plugin/persisted-scope/), [Dialog](https://v2.tauri.app/plugin/dialog/).

### What Tauri mode gives up (and what it could gain)

- **SCIP precision tier (§6.2 of the main doc)**: compiler-grade resolution (interface satisfaction, path aliases, re-export chains) needs SCIP indexers + `node_modules` — heavier than the desktop should carry, so it stays the documented BFF/worker tier behind the same `AnalysisEngine` interface. Deep v1 (tree-sitter name resolution over the clone) ships in the desktop today.
- **`markFileAsViewed` GraphQL sync**: works — it's just a gateway call with the gh token.
- **Team/shared progress**: local-only by definition; the hosted-web + BFF deployment remains the multi-user path (why the BFF survives).

---

## 7. Security posture

- Token: in webview memory only — never written to the Store file, never in a URL, never logged.
- Shell plugin scope: pinned to the exact program+args `gh auth token` — the webview cannot run arbitrary commands even if compromised.
- HTTP plugin scope: allowlist `api.github.com` only.
- CSP: same self-contained SPA rules as the web build; no remote script origins.
- The threat model is "personal tool on your own machine" — the BFF's stricter posture (encrypted token vault, per-user access checks) remains for the hosted deployment.

---

## 8. Migration plan (ordered, each slice verified)

1. **Extract `packages/engine`** — move the table in §4, add the `GrammarSource` seam, BFF consumes the package. _Verify: all 49 existing tests green with zero test-body changes (imports only)._
2. **Webview grammar loading** — bundle the two grammar wasm files + tree-sitter core wasm as Vite assets; add the fetch-based `GrammarSource`. _Verify: a vitest browser-mode (or jsdom + fetch-mock) test parses the PR #42 fixture identically to the node loader — same §7 symbol set._
3. **`TauriPrClient`** in `apps/web/src/service/tauri/` behind `env.tauriMode`. _Verify: fixture-gateway run in plain browser dev produces the §8.1 ranking table — the engine now runs in the page._
4. **Home screen** — `{home | review}` app state, URL input with inline parse hints, "My repos" linked-repo cards (`PrSummary` contract + `listOpenPullRequests` on gateway/PrClient/BFF route), storage-backed repo-link registry. _Verify: in browser dev with the fixture gateway, a seeded `acme/webapp` link lists PR #42 and clicking it lands on the review screen._
5. **`apps/desktop` shell** — Tauri scaffold, five plugins, gh-token startup, CLI arg → deep link, error screens. _Verify: `pr-visualizer <real-pr-url>` on a small public repo renders the graph end-to-end; plain open lands on home._
6. **CLI polish** — Single Instance forwarding, `pr-visualizer` on PATH (npm bin shim or `tauri build` artifact), packaging. _Verify: two consecutive invocations reuse one window._

Slices 1–4 are pure TypeScript and testable without installing Rust; only slice 5 needs the Tauri toolchain.

---

## 9. Reading list for the implementer

1. §3 — internalize the three seams; the whole design is "add implementations, don't add seams".
2. §4 table — the move list is exhaustive; if a file not on the list wants to move, the boundaries are drifting (flag it).
3. §6 — `TauriPrClient` and the home screen are the only new behavior-bearing code in the web app.
4. §8 — do the slices in order; 1–4 land value (engine-in-browser + PR picker) even before any Rust exists.
