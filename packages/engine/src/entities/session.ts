// The authenticated GitHub viewer identity (docs/architecture.md §12). It lives here,
// with the gateway contract, because it is the return type of `getViewer()` — the
// engine owns it. The server's `Session` (which also holds the token) builds on it and
// re-exports this type, so there is one definition. Only these safe public fields ever
// cross to the SPA (via /api/me); the GitHub token never leaves the server.

export type SessionUser = {
  userId: string
  login: string
  name: string | null
  avatarUrl: string | null
}
