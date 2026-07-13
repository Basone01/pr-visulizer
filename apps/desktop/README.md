# apps/desktop — PR Visualizer desktop shell

A Tauri 2 window around the existing web SPA (`apps/web`). No server process, no OAuth: the
GitHub token is borrowed from `gh auth token`, and the analysis engine runs inside the
webview. See `docs/tauri-architecture.md` §5–§7 for the design.

Custom Rust is ~zero — the shell is five official plugins plus a single-instance callback.

## Prerequisites

- Rust toolchain (`rustup`) and, on macOS, the Xcode Command Line Tools.
- The GitHub CLI (`gh`) installed and signed in: `gh auth login`.

## Dev loop

From the repo root:

```sh
pnpm install
pnpm desktop:dev
```

`beforeDevCommand` starts the web dev server (`pnpm --filter @pr-visulizer/web dev` on
`http://localhost:5173`) and Tauri opens a native window pointed at it. Hot-reload works as in
the browser. The webview injects `__TAURI_INTERNALS__`, so the SPA boots in desktop mode
automatically (no env flag).

## Build

```sh
pnpm desktop:build            # release bundle (.app + .dmg on macOS)
pnpm desktop:build -- --debug # faster debug bundle
```

`beforeBuildCommand` builds the web app to `apps/web/dist`, which the config serves as
`frontendDist`. The macOS app is written to:

```
apps/desktop/src-tauri/target/release/bundle/macos/PR Visualizer.app
# or, for --debug:
apps/desktop/src-tauri/target/debug/bundle/macos/PR Visualizer.app
```

The executable inside is named `pr-visualizer`.

## CLI on PATH (`pr-visualizer <pr-url>`)

The CLI is an optional accelerator over the same binary. `bin/pr-visualizer` (repo root) is a
shim that execs the app binary and forwards args; the Single Instance plugin makes a second
invocation focus the already-open window instead of spawning a second app.

1. Install the app (drag `PR Visualizer.app` to `/Applications`), **or** keep a local build.
2. Symlink the shim onto your PATH:

   ```sh
   ln -s "$(pwd)/bin/pr-visualizer" /usr/local/bin/pr-visualizer
   ```

3. Use it:

   | Command                  | Lands on                |
   | ------------------------ | ----------------------- |
   | `pr-visualizer`          | home screen             |
   | `pr-visualizer <pr-url>` | that PR's review screen |

Accepted URL forms: `https://github.com/owner/repo/pull/42`, `owner/repo#42`, `owner/repo/42`.

The shim prefers the installed `/Applications` app; if it isn't there it falls back to a local
`release`/`debug` build under `apps/desktop/src-tauri/target/`, so it also works straight from
a dev checkout.

## Security posture (§7)

- Token: webview memory only — never written to the Store, a URL, or a log.
- Shell scope: pinned to exactly `gh auth token`; no other command can run.
- HTTP scope: allowlist `https://api.github.com/*` only.
