# pr-visulizer — repo conventions

PR Review Visualizer: web app that turns a GitHub PR into a dependency graph, ranks review order, and submits reviews back to GitHub.

**The architecture is decided — read `docs/architecture.md` before implementing anything.**
Section numbers referenced in code comments and tasks (§3 data model, §5 fast engine, §8 ranking, …) refer to that document.
The PR #42 worked-example numbers in §7–§8 are executable test fixtures — ranking tests assert against exactly those values.

## Layout (pnpm workspaces)

```
apps/web        — React SPA (Vite). Graph view, diff panel, review tray.
apps/server    — Fastify BFF. Auth, GitHub gateway, analysis engines, review service.
packages/shared — zod schemas + types used by BOTH sides (the contract). Build this first.
```

- The SPA never re-declares a server type — it imports from `packages/shared`.
- `apps/server` organizes by category (entities / services / utils) per the node conventions below.
- Engines implement one `AnalysisEngine` interface (§4); the ranking core is pure functions (§8) — controllable core + presets (`RankingPolicy`), independently testable without the server.
- The design system source is `design/build.mjs` (pushed to Claude Design); app UI colors/type must use the same tokens (`design/tokens.css` / `tokens.ts`).

## Desktop release builds

- Every macOS release build must be Developer ID signed and notarized.
- Use `pnpm desktop:build`, which must sign, notarize, staple, and verify the release before copying it to iCloud `MacOSBuiltApps`.
- Missing credentials or failed verification must fail the build, never distribute an unsigned fallback.
- Verify the actual app and DMG before reporting a release ready for another Mac.

## Stack conventions

@/Users/basone01/dev/project/dot-ai/AGENTS.architecture.md
@/Users/basone01/dev/project/dot-ai/AGENTS.frontend.md
@/Users/basone01/dev/project/dot-ai/AGENTS.node.md
