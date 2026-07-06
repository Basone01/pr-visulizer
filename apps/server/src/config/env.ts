import { z } from "zod"

// The ONE place process.env is read (docs/architecture.md §12). Parsed once at
// startup; a bad/missing var fails fast here instead of surfacing as a mystery
// `undefined` deep in a handler. Every other module depends on the typed `Env`.

const booleanFlag = z
  .string()
  .optional()
  .transform((value) => value === "1" || value?.toLowerCase() === "true")

const envSchema = z.object({
  // Boot with the fixture-backed fake gateway (no GitHub network) — local dev / tests.
  GITHUB_FAKE: booleanFlag,

  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default("127.0.0.1"),

  // Signs the httpOnly session cookie (§12). A weak dev default; MUST be set in prod.
  SESSION_SECRET: z.string().min(1).default("dev-insecure-session-secret-change-me"),
  COOKIE_NAME: z.string().default("prv_session"),

  // GitHub OAuth app (real auth). Optional so fake/dev mode boots without them.
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_OAUTH_REDIRECT: z.string().url().default("http://127.0.0.1:3001/api/auth/callback"),

  // Personal access token — a dev shortcut so the real gateway works without OAuth.
  GITHUB_TOKEN: z.string().optional(),

  // Local-dev auth bypass: when set, every request is this user (no login needed).
  DEV_USER: z.string().optional(),

  // SQLite location for the progress store (§3). ":memory:" is ephemeral (tests).
  DATABASE_URL: z.string().default(":memory:"),
})

export type Env = z.infer<typeof envSchema>

// Parse-don't-validate at the boundary: on failure, print the field errors and exit.
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source)

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n")
    throw new Error(`Invalid environment configuration:\n${details}`)
  }

  return parsed.data
}
