# PR Review Visualizer — Architecture

A web app that turns a GitHub pull request into a dependency graph, tells the reviewer **where to start** and **what to review next**, shows a rich diff per file, and submits the finished review back to GitHub.

Written for a junior engineer with no prior context.
You should be able to start building from this document without further design decisions.

---

## 1. The problem, in one paragraph

GitHub shows PR files **alphabetically**.
But code has a direction: a route handler calls a middleware, the middleware calls a library, the library reads a config.
If you review the route first, you read call sites of functions you have never seen.
If you review the config and library first, every later file is built from parts you already understand.
This app computes that "foundations first" order automatically, visualizes it as a node graph, and walks the reviewer through it.

---

## 2. System shape

**SPA + thin backend (BFF — Backend For Frontend).**

```
┌──────────────────────── Browser ────────────────────────┐
│  React SPA                                              │
│  ├─ Graph view        (node graph, review order)        │
│  ├─ Diff panel        (rich per-file diff)              │
│  └─ Review tray       (checkmarks, drafts, submit)      │
└───────────────┬─────────────────────────────────────────┘
                │  HTTPS (JSON), session cookie
┌───────────────▼─────────────────────────────────────────┐
│  BFF (Node + TypeScript, Fastify)                       │
│  ├─ Auth service      GitHub OAuth, token vault         │
│  ├─ GitHub gateway    Octokit wrapper, ETag cache       │
│  ├─ Analysis service  two engines, one contract (§4):   │
│  │    ├─ FastAstEngine   tree-sitter, in-process (def.) │
│  │    └─ DeepLspEngine   enqueue → worker (opt-in)      │
│  └─ Review service    progress store, review submit     │
├─────────────────────────────────────────────────────────┤
│  Storage:  SQLite (users, sessions, review progress)    │
│            in-process LRU cache (analysis, by headSha)  │
└───────┬───────────────────────┬─────────────────────────┘
        │  REST + GraphQL       │ job queue (deep mode only)
        │  (Octokit)    ┌───────▼─────────────────────────┐
        │               │  Analysis worker(s)             │
        │               │  shallow clone @ headSha        │
        │               │  → SCIP indexer per language    │
        │               │  → repo-wide reference graph    │
        │               │  clone cache + disk quota       │
        │               └───────┬─────────────────────────┘
┌───────▼────────┐             │ clone / raw fetch
│   GitHub API   │◀────────────┘
└────────────────┘
```

Why this shape and not the alternatives:

| Concern | Client-only SPA | **SPA + BFF (chosen)** | Full GitHub-App platform |
|---|---|---|---|
| GitHub token | lives in the browser (risky) | server-side only, never sent to browser | server-side |
| Heavy parsing | strains the browser tab | on the server, cached | on workers |
| Infra to run | none | one small service | queue + workers + DB |
| Team features / webhooks | no | not yet (upgrade path exists) | yes |

The BFF gives the two properties we cannot compromise on — token safety and server-side parsing — at the minimum infra cost.
Full-clone LSP-grade analysis is not a rejected alternative — it is the opt-in **deep engine** (§4, §6), and the worker box above only exists when you enable it.
The full-platform shape (webhooks, pre-analysis) stays as a later upgrade path (see §13).

### 2.1 Tech stack

| Layer | Choice | Why |
|---|---|---|
| SPA | React + TypeScript + Vite | standard, huge ecosystem |
| Server state | TanStack Query | caching, polling, retries out of the box |
| Graph rendering | React Flow + `elkjs` layered layout | topo levels map 1:1 to layout columns |
| Diff rendering | `shiki` highlight + own unified-diff renderer | syntax colors + clickable symbol anchors (def ↔ usage, §10) |
| BFF | Node + TypeScript + Fastify | fast, typed, tiny |
| GitHub client | Octokit (REST + GraphQL) | official, handles pagination/rate limits |
| Parsing | `web-tree-sitter` (WASM grammars) | no native-build pain, one grammar file per language |
| Validation | zod at every boundary | parse-don't-validate |
| DB (MVP) | SQLite (drizzle) | zero-ops; swap to Postgres when multi-instance |

Monorepo layout (pnpm workspaces):

```
apps/web        — React SPA
apps/server     — Fastify BFF
packages/shared — zod schemas + types used by BOTH sides (the contract)
```

The shared package is the type-safety spine.
The SPA never re-declares a server type by hand — it imports the schema.

---

## 3. Data model

Everything below lives in `packages/shared` as zod schemas.

```ts
// The output of the analysis pipeline. Immutable per (headSha, engine).
// BOTH engines emit this shape — the SPA never knows which one ran.
type AnalysisResult = {
  engine: 'fast' | 'deep';
  pr: {
    owner: string; repo: string; number: number;
    title: string;
    baseSha: string;
    headSha: string;          // cache key — new push = new SHA = new analysis
  };
  files: ChangedFile[];
  symbols: ChangedSymbol[];
  edges: Edge[];
  ranking: RankedFile[];      // precomputed static order (see §8)
  ghosts: GhostFile[];        // deep engine only — unchanged files that USE changed code
  occurrences: SymbolOccurrence[];   // powers def ↔ usage navigation in the diff (§10)
};

// One place a symbol appears in the PR's files. Free by-product of edge
// resolution: fast engine records these in step 7, deep engine gets them from SCIP.
type SymbolOccurrence = {
  symbolId: string;           // the ChangedSymbol this refers to
  path: string;
  line: number;               // in the head version
  role: 'definition' | 'usage';
};

type ChangedFile = {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  language: string | null;    // null = no tree-sitter grammar → heuristic mode
};

type ChangedSymbol = {
  id: string;                 // `${path}#${name}`
  path: string;
  name: string;
  kind: 'function' | 'method' | 'class' | 'type' | 'const';
  span: { startLine: number; endLine: number };   // in the head version
  changeKind: 'added' | 'modified' | 'deleted';
};

type Edge = {
  from: string;               // file path or symbol id — "from DEPENDS ON to"
  to: string;
  kind: 'imports' | 'calls' | 'uses-type';
  level: 'file' | 'symbol';
  source: 'ast' | 'lsp' | 'heuristic';   // which engine/fallback produced it
};

type RankedFile = {
  path: string;
  topoLevel: number;          // 0 = depends on no other CHANGED file
  fanIn: number;              // how many changed files depend on it
  churn: number;              // additions + deletions
  order: number;              // 1-based position in the static order
  blastRadius?: number;       // deep engine only — UNCHANGED files that depend on it
};

// deep engine only: an unchanged file that references changed code.
// Rendered as a dashed "ghost" node — context, never part of the review queue.
type GhostFile = {
  path: string;
  usedChangedSymbols: string[];   // which changed symbols it references
};
```

Review progress is per user, per PR, per SHA:

```ts
type ReviewProgress = {
  userId: string;
  owner: string; repo: string; prNumber: number;
  headSha: string;
  reviewedFiles: string[];    // the checkmarks
  drafts: DraftComment[];
  verdict?: 'approve' | 'request_changes' | 'comment';
};

type DraftComment = {
  path: string;
  line: number;               // line in the head version
  side: 'LEFT' | 'RIGHT';
  body: string;
};
```

**Edge direction convention (memorize this):** `from → to` means *"from depends on to"*.
All algorithms below assume this direction.

---

## 4. Two engines, one contract

The user chooses how deep the analysis goes.
Both engines implement one interface and emit the same `AnalysisResult` — the graph UI, ranking, and review flow are engine-blind.

```ts
interface AnalysisEngine {
  // keyed by (owner, repo, prNumber, headSha, engineName) — immutable per key
  analyze(target: PrTarget): Promise<AnalysisResult>;
}

class FastAstEngine implements AnalysisEngine { /* §5 — tree-sitter, in-process  */ }
class DeepLspEngine implements AnalysisEngine { /* §6 — clone + SCIP, on workers */ }
```

### 4.1 When to use which

| | **Fast (AST)** — default | **Deep (LSP-grade)** — opt-in |
|---|---|---|
| What it reads | changed files only (+1-hop imports) | the whole repo at `headSha` |
| How | tree-sitter parse + name resolution | shallow clone + SCIP compiler-grade index |
| Latency | seconds | 1–10 min depending on repo size |
| Extra infra | none | job queue + worker pool + disk |
| Call edges | best-effort (misses dynamic dispatch, re-export chains) | precise references |
| Blast radius (unchanged callers of changed code) | invisible | ghost nodes + `blastRadius` metric |
| Monorepo path aliases | needs the `tsconfig.json` fetch hack | resolved natively by the indexer |
| Good for | everyday PRs, instant feedback | risky refactors, core-library changes, huge monorepos |

### 4.2 Progressive upgrade, not either/or

The fast result is not thrown away when the user picks deep — deep **upgrades** it:

```
PR opened ──▶ FastAstEngine runs automatically ──▶ graph on screen in seconds
                                                        │
                            user clicks "Deepen analysis" (or a repo setting auto-triggers it)
                                                        │
              DeepLspEngine job enqueued ──▶ worker clones + indexes ──▶ deep result ready
                                                        │
              SPA swaps the graph data; edges re-tagged source:'lsp'; ghost nodes appear;
              checkmarks and drafts SURVIVE (progress is keyed by headSha, not by engine)
```

Three invariants make this safe:

- **Same contract** — swapping results is a re-render, not a new UI mode.
- **Progress is engine-independent** — `ReviewProgress` never references edges, only file paths.
- **Deep can only add** — every fast edge is either confirmed (re-tagged `lsp`) or kept as `ast`; files never disappear, so a half-reviewed queue never loses items. Review *order* of still-unreviewed files may improve — the UI badges re-ranked rows instead of silently reshuffling.

If the deep job fails or times out, the fast result simply stays — deep mode is an enhancement with a built-in fallback, never a gate.

---

## 5. Fast engine — AST pipeline (default, in-process)

Triggered on first open of a PR, keyed by `(owner, repo, prNumber, headSha)`.
Because the key contains the SHA, a cached result is immutable — there is no invalidation logic.
A new push produces a new SHA and simply misses the cache.

```
1. Fetch PR meta + changed-file list        GET /repos/{o}/{r}/pulls/{n}
2. Fetch unified diff per file               (patch field of /pulls/{n}/files)
3. Fetch FULL content of each changed file   at headSha (contents API)
4. Parse each file with tree-sitter          → symbols with line spans
5. Map diff hunks → changed symbols          (line-range intersection)
6. Resolve imports                           → file-level edges
7. Resolve calls / type-uses                 → symbol-level edges (best effort)
8. Compute ranking                           → topo levels, fan-in, static order
9. Cache AnalysisResult                      LRU keyed by headSha
```

### Step 4 — symbol extraction

One tree-sitter grammar per language (ship TypeScript/JavaScript and Go first).
A per-language query file extracts declarations:

```
(function_declaration name: (identifier) @name) @symbol
(type_alias_declaration name: (type_identifier) @name) @symbol
...
```

Each match becomes a `ChangedSymbol` candidate with its line span.

### Step 5 — hunk → symbol mapping

A unified-diff hunk header `@@ -a,b +c,d @@` says the head version touched lines `[c, c+d)`.
A symbol whose span intersects that range is marked `modified`.
Symbols in an `added` file are all `added`.
This is pure interval intersection — no parsing of the diff body needed.

### Step 6 — import resolution

For each `import ... from './x'` in a changed file, resolve the specifier to a repo path.
Relative paths resolve directly.
Aliased paths (`@app/...`) need the repo's `tsconfig.json` at headSha — fetch it once per analysis.
An import that resolves to another **changed** file becomes a graph edge.
Imports to unchanged files are recorded but do not affect ranking (the reviewer already trusts unchanged code).

### Step 7 — call edges (honest about limits)

Within the fetched file set:
index every exported symbol name per file, then for each changed symbol's body, tree-sitter-query the call expressions and member accesses, and resolve each identifier through the file's import bindings to a target `(file, symbol)`.

This is **name resolution, not type inference**.
It will miss dynamic dispatch and complex re-export chains.
That is acceptable: edges feed a review-order *heuristic*, not a compiler.
File-level import edges (step 6) are the reliable backbone; symbol edges add precision where they can.

Each successful resolution is also recorded as a `SymbolOccurrence` (definition line from the tree-sitter span, usage line from the call site).
That list is the entire data source for def ↔ usage navigation in the diff panel (§10) — the feature costs no extra analysis pass.

### Fallbacks and limits

| Situation | Behavior |
|---|---|
| No grammar for a language | file stays in the graph (grey node), edges from import-line regex only |
| PR > 300 files | full AST for the top-churn 300, heuristic mode for the rest — the UI must say so |
| Circular imports | Tarjan SCC → collapse the cycle into one super-node, members share a topo level, UI badge "review together" |
| GitHub rate limit | ETag conditional requests + the SHA-keyed cache keep repeat cost near zero |

---

## 6. Deep engine — LSP-grade pipeline (opt-in, on workers)

"LSP-grade" is the precision target; the implementation is **SCIP indexers**, not live LSP servers.
A live language server is a long-running process you query interactively — wrong shape for a batch job.
A SCIP indexer (`scip-typescript`, `scip-go`, …) runs once over a checkout and emits one index file containing every definition and reference, compiler-grade.
Same data you would get from asking an LSP "find references" on everything, produced in one shot.

```
1. BFF enqueues job                    (repo, headSha, languages)      pg-boss on the existing SQLite/Postgres
2. Worker: shallow clone               git clone --depth 1 @ headSha   clone cache keyed by (repo, headSha)
3. Optional: install deps SAFELY       pnpm install --ignore-scripts   TS resolution needs node_modules; see §12
4. Run SCIP indexer per language       scip-typescript / scip-go       timeout + disk quota per job
5. Load index → symbol table + refs
6. Project onto the PR                 changed symbols + ALL their references, incl. unchanged files
7. Build edges (source: 'lsp')         precise calls / uses-type; unchanged dependents → GhostFile[]
8. Same ranking algorithm (§8)         richer fanIn + blastRadius per changed file
9. Store AnalysisResult                on disk / object store (deep results are big), keyed by (headSha, 'deep')
```

### What deep mode adds, concretely

On PR #42 (§7), suppose an **unchanged** file `src/api/routes/admin.ts` also calls `withRateLimit`.
The fast engine cannot see it — it never reads unchanged files.
The deep engine emits it as a ghost node with a dashed edge, and `withRateLimit.ts` gets `blastRadius: 1`.
The reviewer now knows: *this middleware change affects a route that is not in the diff* — often the exact thing that makes a "small PR" risky.

Ghosts are context, never work: they are excluded from the review queue, the readiness math, and the checkmark list.
`topoLevel` and `fanIn` stay defined over changed files only, so the review order stays comparable across engines; `blastRadius` is a separate risk signal shown as a badge.
Deep mode also upgrades `occurrences` from "what step 7 could resolve" to the compiler-grade, repo-wide set — so symbol navigation (§10) gains targets in ghost files too.

### Worker constraints (the honest cost of deep mode)

- One clone per (repo, headSha), wiped after indexing; LRU disk cache with a hard quota.
- Per-job timeout (default 10 min) — on timeout the job dies and the fast result stands.
- Indexers run in a sandboxed container: no network except the package registry, CPU/memory limits, and **never execute repo code** (`--ignore-scripts` on installs — see §12).
- Skipping dependency install keeps the job fast but degrades cross-package resolution in TS monorepos; this is a per-repo setting, default off (skip install).

---

## 7. Worked example — the PR we trace everywhere

Every number in §7–§8 (and every animation frame in the HTML version) uses this PR.

**PR #42 — "Add login rate limiting"**, 6 changed files, TypeScript:

| # | File | Status | Churn (＋/−) | Imports (of changed files) |
|---|---|---|---|---|
| 1 | `src/config/limits.ts` | added | +4 −0 | — |
| 2 | `src/types/http.ts` | modified | +2 −1 | — |
| 3 | `src/lib/rateLimiter.ts` | added | +48 −0 | `limits.ts` |
| 4 | `src/middleware/withRateLimit.ts` | added | +26 −0 | `rateLimiter.ts`, `http.ts`, `limits.ts` |
| 5 | `src/api/routes/login.ts` | modified | +6 −2 | `withRateLimit.ts` |
| 6 | `src/lib/rateLimiter.test.ts` | added | +52 −0 | `rateLimiter.ts`, `limits.ts` |

The pipeline extracts (abridged):

- `limits.ts` → symbols `RateLimitConfig` (type, added), `LOGIN_RATE_LIMIT` (const, added)
- `http.ts` → symbol `ApiError` (type, **modified** — hunk `@@ -3,2 +3,3 @@` intersects its span; the new optional field `retryAfterSeconds`)
- `rateLimiter.ts` → `createRateLimiter` (fn, added); `uses-type` edge → `limits.ts#RateLimitConfig`
- `withRateLimit.ts` → `withRateLimit` (fn, added); `calls` → `rateLimiter.ts#createRateLimiter`, `uses-type` → `http.ts#ApiError`
- `login.ts` → `loginHandler` (fn, modified); `calls` → `withRateLimit.ts#withRateLimit`
- `rateLimiter.test.ts` → test cases; `calls` → `createRateLimiter`

File-level dependency edges (from → to = depends on):

```
rateLimiter      → limits
withRateLimit    → rateLimiter, http, limits
login            → withRateLimit
rateLimiter.test → rateLimiter, limits
```

---

## 8. The ranking algorithm

Two parts: a **static order** computed once, and a **dynamic "best next"** recomputed after every checkmark.

### 8.1 Static order — "where to start"

Three signals per file:

- **`topoLevel`** — `0` if the file depends on no other *changed* file, else `1 + max(topoLevel of its changed dependencies)`. Lower = more foundational.
- **`fanIn`** — how many changed files depend on it. Higher = more of the PR is built on it.
- **`churn`** — additions + deletions. A tie-breaker only.

Sort: `topoLevel` ascending → `fanIn` descending → `churn` descending → path ascending.

Traced on PR #42 (verified by executing the algorithm, not by hand):

| Order | File | topoLevel | Why this level | fanIn | churn |
|---|---|---|---|---|---|
| 1 | `limits.ts` | 0 | no changed deps | **3** | 4 |
| 2 | `http.ts` | 0 | no changed deps | 1 | 3 |
| 3 | `rateLimiter.ts` | 1 | depends on limits (L0) | 2 | 48 |
| 4 | `withRateLimit.ts` | 2 | depends on rateLimiter (L1) | 1 | 26 |
| 5 | `rateLimiter.test.ts` | 2 | depends on rateLimiter (L1) | 0 | 52 |
| 6 | `login.ts` | 3 | depends on withRateLimit (L2) | 0 | 8 |

Start file = `limits.ts`: it is level 0 **and** three other files are built on it — 4 lines that unlock the rest of the PR.

Note what fell out for free: **tests rank after their subject** with no special-casing, because a test *imports* its subject and therefore always sits one topo level above it.

### 8.2 Dynamic "best next" — after every checkmark

The static order assumes the reviewer follows it.
Real reviewers jump around, so after each checkmark we recompute:

```
readiness(f) = reviewed changed-deps of f / total changed-deps of f
               (files with no changed deps have readiness 1.0)

next = unreviewed file with max readiness
       tie → lower topoLevel → higher fanIn → path ascending
```

`readiness = 1.0` means *"you have already reviewed everything this file is built from — you have full context right now."*

Traced on PR #42, reviewer following suggestions (all six steps, readiness of every unreviewed file):

| Step | Reviewed so far | limits | http | rateLimiter | withRateLimit | test | login | → Suggest |
|---|---|---|---|---|---|---|---|---|
| 1 | — | **1.00** | 1.00 | 0.00 | 0.00 | 0.00 | 0.00 | `limits` (tie with http → higher fanIn 3 vs 1) |
| 2 | limits | ✓ | **1.00** | 1.00 | 0.33 | 0.50 | 0.00 | `http` (tie with rateLimiter → lower topoLevel 0 vs 1) |
| 3 | +http | ✓ | ✓ | **1.00** | 0.67 | 0.50 | 0.00 | `rateLimiter` |
| 4 | +rateLimiter | ✓ | ✓ | ✓ | **1.00** | 1.00 | 0.00 | `withRateLimit` (tie with test → higher fanIn 1 vs 0) |
| 5 | +withRateLimit | ✓ | ✓ | ✓ | ✓ | **1.00** | 1.00 | `test` (tie with login → lower topoLevel 2 vs 3) |
| 6 | +test | ✓ | ✓ | ✓ | ✓ | ✓ | **1.00** | `login` |

And the adaptivity case: if the reviewer ignores the suggestion and reviews `login.ts` first, the next recompute still points at `limits.ts` (readiness 1.0, fanIn 3) — the algorithm never blocks, it only guides.

### 8.3 Ranking is a controllable core with presets

The sort priorities live in one config object, not scattered in code:

```ts
type RankingPolicy = {
  primary: 'topoLevel' | 'fanIn' | 'churnAsc';
  tieBreakers: Array<'topoLevel' | 'fanIn' | 'churn' | 'path'>;
};

const PRESETS = {
  'foundations-first': { primary: 'topoLevel', tieBreakers: ['fanIn', 'churn', 'path'] },  // default
  'blast-radius-first': { primary: 'fanIn',    tieBreakers: ['topoLevel', 'churn', 'path'] },
  'quick-wins':        { primary: 'churnAsc',  tieBreakers: ['topoLevel', 'fanIn', 'path'] },
} satisfies Record<string, RankingPolicy>;
```

Default is `foundations-first` (everything traced above).
A reviewer who prefers small files first flips one setting — no algorithm change.

Engine note: the ranking inputs (`topoLevel`, `fanIn`) are defined over changed files only, so the same policy produces comparable orders under both engines.
Deep mode adds `blastRadius` as a per-file **risk badge**; `blast-radius-first` sorts by `fanIn + blastRadius` when deep data is present.

---

## 9. API contracts (BFF ↔ SPA)

All request/response bodies validated with the shared zod schemas.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/auth/login` | GET | redirect to GitHub OAuth |
| `/api/auth/callback` | GET | exchange code, set httpOnly session cookie |
| `/api/me` | GET | current user |
| `/api/prs/:owner/:repo/:number` | GET | PR meta |
| `/api/prs/:owner/:repo/:number/analysis?engine=fast\|deep` | GET | `AnalysisResult`; default `fast`; returns `202 {status:'analyzing'}` while running — SPA polls (TanStack Query `refetchInterval`) |
| `/api/prs/:owner/:repo/:number/analysis/deepen` | POST | enqueue the deep-engine job; idempotent per headSha (re-POST returns the existing job); SPA then polls `?engine=deep` |
| `/api/prs/:owner/:repo/:number/files/*path?sha=` | GET | file content for the diff renderer (base or head) |
| `/api/prs/:owner/:repo/:number/progress` | GET / PUT | `ReviewProgress` read/write |
| `/api/prs/:owner/:repo/:number/review` | POST | submit the real review to GitHub |

Design notes:

- **202-then-poll** keeps the MVP free of WebSocket infrastructure; analysis of a typical PR is a few seconds.
- The SPA never talks to `api.github.com` — every GitHub call goes through the BFF, where the token lives.
- `PUT progress` is idempotent full-state replacement — simplest possible sync for checkmarks and drafts.

---

## 10. Diff panel — syntax highlight & symbol navigation

Two layers, strictly separated:

- **Background = diff status.** Added lines get `--added-soft`, deleted lines `--deleted-soft` — backgrounds only.
- **Foreground = syntax.** `shiki` tokenizes both sides with the repo's language grammar; token colors come from the app's syntax tokens (light + dark). Diff status never tints the text — the two layers can't fight.

The renderer is our own unified-diff walker feeding line spans to shiki, because we overlay a third layer on top: **symbol anchors**.

### Def ↔ usage navigation (within the PR) — peek first, jump for long ones

Data source: `AnalysisResult.occurrences` — no separate indexing step (see §5 step 7, §6).

Rules:

- An identifier gets a dotted underline **only when its counterpart exists in the PR** (fast engine) or in a ghost file (deep engine). No underline = nothing to navigate to; the UI never dead-ends.
- Click a **usage** → **peek popup**: the definition renders inline in a popover, with the same diff-status + syntax layers as the main view. Most definitions are short — the peek *is* the answer, and the reviewer's scroll position never moves.
- **Long definitions** (span > `peekMaxLines`, default 15 — one more controllable-core setting): the peek shows the first 10 lines with a fade and two actions — **"Show N more ↓"** and **"Jump ⏎"**. *Show more* expands the popup in place; past a max height (~60% of the viewport) the code scrolls **inside** the popup. The reviewer's position in the main diff still never moves. Jump opens that file's diff, scrolls, flash-highlights — for when the definition deserves full-width reading. `⌘`-click bypasses the peek and jumps directly.
- The ladder is **peek → expand → jump**, each step heavier than the last; only the last one pushes the jump stack.
- A **definition** line shows an "N usages in this PR" pill → popover lists every usage **with its one-line context inline** — usages are single lines, so the list is effectively pre-peeked; click one to jump when more context is needed, `⌥]` / `⌥[` cycles.
- Peek is lighter than jump: it pushes nothing. Only real jumps go onto the **jump stack**, and a persistent "↩ back" chip (and `Esc`) returns exactly where you left.
- Any navigation is a **detour, not a context switch**: the review queue, checkmarks, and "suggested next" do not move. Navigation answers "what is this?", the ranking still answers "what do I review next?" — keeping those separate is what stops free navigation from destroying the guided order.
- Deep mode: peeks into ghost files fetch the unchanged content read-only at `headSha`; a jump there opens a read-only file view (there is nothing to review in a ghost).

Edge cases stated up front: a symbol with multiple definitions in the PR (overloads, re-declarations) gets the popover instead of a direct jump; a renamed symbol's old-name usages resolve to the new definition via the rename mapping GitHub provides; on the fast engine, an identifier step 7 could not resolve simply gets no underline — precision over coverage.

---

## 11. Review-submit flow (checkmarks → real GitHub)

```
reviewer clicks ✓ on a file
  → SPA: optimistic update + PUT /progress
  → BFF: save to SQLite
  → BFF: GraphQL mutation markFileAsViewed(pullRequestId, path)   ← real GitHub "Viewed" sync

reviewer drafts inline comments
  → stored in ReviewProgress.drafts (app-side only, invisible to GitHub)

reviewer picks verdict + clicks Submit
  → POST /api/prs/.../review
  → BFF: POST /repos/{o}/{r}/pulls/{n}/reviews
         { commit_id: headSha,
           event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
           body, comments: [{ path, line, side, body }] }
  → one real GitHub review appears on the PR, comments anchored to lines
```

Two details a junior would miss:

- GitHub's own file-viewed checkbox is exposed **only in the GraphQL API** (`markFileAsViewed`) — using it means our checkmarks show up in the native GitHub UI too.
- **Force-push while drafting:** the new headSha invalidates draft line anchors. On next load the BFF re-analyzes at the new SHA, remaps each draft by hunk proximity, and flags any comment it could not remap instead of silently dropping it.

---

## 12. Security notes

- GitHub token: server-side only, encrypted at rest, never serialized into any API response.
- Session: httpOnly + SameSite=Lax cookie; CSRF token required on PUT/POST.
- OAuth scopes: start minimal (`repo` read + PR write); moving to a GitHub App later gives per-repo installation instead of account-wide scope.
- The BFF validates that the session user actually has read access to `owner/repo` before serving any cached analysis (the cache must not leak private code across users).

Deep-engine specifics (a clone of untrusted code is a bigger attack surface than an API fetch):

- **Never execute repo code.** No build scripts, no test runs; dependency installs — when enabled at all — use `pnpm install --ignore-scripts` (postinstall scripts are the classic supply-chain execution vector).
- Workers run in a sandboxed container: no outbound network except GitHub + the package registry, CPU/memory/disk quotas, per-job timeout.
- Clones are wiped after indexing; the disk cache holds SCIP indexes (data), not checkouts.

---

## 13. Upgrade path (explicitly out of MVP scope)

| Later need | Change |
|---|---|
| Pre-analysis on PR open | become a GitHub App, add webhook → queue → worker (the deep-engine queue from §6 is reused as-is) |
| Teams / shared progress | Postgres, progress keyed per (user, PR) with team overlays |
| More languages | fast engine: ship tree-sitter grammars; deep engine: add SCIP indexers — both pipelines are language-agnostic past parsing |

---

## 14. Reading list for the implementer

1. §3 data model → build `packages/shared` first, including `engine`, `Edge.source`, and `GhostFile` from day one — retrofitting the contract later is the expensive path.
2. §5 fast engine → the core; steps 1–6 make a working file-level MVP, step 7 is an enhancement.
3. §8 ranking → pure functions over `AnalysisResult`; write the 3A unit tests against the PR #42 numbers above (they are executable fixtures).
4. §9–§11 → wire the SPA last; the graph UI is useless until the analysis is right.
5. §6 deep engine → build last, behind the `AnalysisEngine` interface; nothing upstream changes when it lands.
