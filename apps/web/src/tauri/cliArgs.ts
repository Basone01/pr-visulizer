import { parsePrTarget } from "@/utils/prUrl/parsePrTarget"

import type { PrTarget } from "@/entity/pr"

// The CLI boundary (docs/tauri-architecture.md §5): the desktop shell's one positional `url`
// arg, and the argv a second invocation forwards. Both are untrusted strings — this wrapper
// turns them into a typed target (or null) so the caller never touches the raw plugin API.

// The cold-start `pr-visualizer <url>` arg, or null when launched without one. Matching can
// throw on some launch paths (Finder passes `-psn_…` on macOS) — treat that as "no arg".
export async function readCliUrlArg(): Promise<string | null> {
  try {
    const { getMatches } = await import("@tauri-apps/plugin-cli")
    const matches = await getMatches()
    const value = matches.args.url?.value

    return typeof value === "string" && value.length > 0 ? value : null
  } catch {
    return null
  }
}

// A second invocation forwards its whole argv (docs/tauri-architecture.md §6). The URL is
// whichever entry parses as a PR target — argv[0] is the binary path, and launchers may add
// their own flags, so scan rather than assume a fixed index.
export function targetFromForwardedArgv(argv: readonly string[]): PrTarget | null {
  for (const arg of argv) {
    const target = parsePrTarget(arg)
    if (target) return target
  }

  return null
}

// Register a listener for forwarded second-instance argv. Returns an unlisten function.
export async function onSecondInstance(handler: (argv: string[]) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event")
  return listen<string[]>("single-instance", (event) => handler(event.payload))
}
