import { z } from "zod"

// The authenticated viewer's public identity, as served by GET /api/me (docs/architecture.md
// §9, §12). The SPA parses it here at the boundary; the GitHub token never crosses. This is
// the same safe shape the engine's SessionUser carries — structurally identical, so a gateway
// viewer satisfies it — but the wire boundary needs a runtime schema, which lives in shared.
export const viewerSchema = z.object({
  userId: z.string(),
  login: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
})
export type Viewer = z.infer<typeof viewerSchema>
