import { z } from "zod"

// The browser env is a boundary like any other — parse it, don't trust it.
// Vite only exposes VITE_-prefixed vars to the client; that prefix IS the
// server/client boundary, so no server secret can leak here.
const envSchema = z.object({
  // "1" turns on fixture mode: the PR #42 analysis is served client-side so the
  // SPA renders end-to-end without the BFF (docs/architecture.md verify note).
  fixture: z
    .string()
    .optional()
    .transform((value) => value === "1"),
})

const parsed = envSchema.parse({
  fixture: import.meta.env.VITE_FIXTURE,
})

export const env = {
  fixtureMode: parsed.fixture,
} as const
