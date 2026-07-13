import type { SessionUser } from "@pr-visulizer/engine"

// Session identity (docs/architecture.md §12). `SessionUser` now lives with the gateway
// contract in `@pr-visulizer/engine` (its `getViewer()` return type); re-exported here so
// existing server call sites keep importing it from `../entities`. The GitHub token never
// leaves the server and is never serialized into any response — only `SessionUser` (safe
// public fields) ever crosses to the SPA.
export type { SessionUser }

// What the BFF holds for an authenticated session. `githubToken` stays server-side.
export type Session = {
  user: SessionUser
  githubToken: string
}
