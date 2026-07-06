import type { PrTarget } from "@/entity/pr"

import { AppShell } from "./AppShell"

// The PR under review comes from the URL (?owner=&repo=&number=); the fake-gateway
// fixture PR #42 (acme/web) is the default so a bare open still shows something.
const FIXTURE_PR: PrTarget = { owner: "acme", repo: "web", number: 42 }

function targetFromUrl(): PrTarget {
  const params = new URLSearchParams(window.location.search)
  const owner = params.get("owner")
  const repo = params.get("repo")
  const number = Number(params.get("number"))

  if (!owner || !repo || !Number.isInteger(number) || number <= 0) return FIXTURE_PR

  return { owner, repo, number }
}

export function App() {
  return <AppShell target={targetFromUrl()} />
}
