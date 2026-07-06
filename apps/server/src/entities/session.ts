// Server-only session identity (docs/architecture.md §12). The GitHub token never
// leaves the server and is never serialized into any response — only `SessionUser`
// (safe public fields) ever crosses to the SPA.

export type SessionUser = {
  userId: string
  login: string
  name: string | null
  avatarUrl: string | null
}

// What the BFF holds for an authenticated session. `githubToken` stays server-side.
export type Session = {
  user: SessionUser
  githubToken: string
}
