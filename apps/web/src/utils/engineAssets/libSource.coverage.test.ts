// @vitest-environment node
//
// The webview loads TypeScript's type library as `?raw` glob chunks. `loadLibChain` walks the
// `/// <reference lib="…" />` graph from the default lib, so the set of names it can request is
// determined by the lib files themselves — not by anything we control.
//
// This is the libSource twin of `grammarSource.parity.test.ts`'s coverage test: EVERY name the
// chain-walk can ask for must exist in the glob, or the compiler silently runs with a partial
// type library (missing `Array.prototype.map`, `Promise`, …) and the tier produces wrong,
// quietly-degraded results. Node tests would never notice — the node LibSource reads any file
// off disk.
import { readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"

import { DEFAULT_LIB } from "@pr-visulizer/engine/browser"

const requireFromHere = createRequire(import.meta.url)
const TS_LIB_DIR = requireFromHere.resolve("typescript").replace(/\/typescript\.js$/, "")

// What the browser glob `/node_modules/typescript/lib/lib.*.d.ts` matches — computed from the
// same installed package Vite globs at build time.
const GLOBBED_LIB_NAMES = new Set(
  readdirSync(TS_LIB_DIR).filter((name) => /^lib\..*\.d\.ts$/.test(name))
)

const REFERENCE_LIB = /\/\/\/\s*<reference\s+lib\s*=\s*"([^"]+)"\s*\/>/g

// Exactly the walk `loadLibChain` performs, over the real files.
function namesRequestedByChainWalk(entry: string): string[] {
  const requested: string[] = []
  const seen = new Set<string>()
  const queue = [entry]

  while (queue.length > 0) {
    const name = queue.pop()!
    if (seen.has(name)) continue

    seen.add(name)
    requested.push(name)

    let text: string
    try {
      text = readFileSync(`${TS_LIB_DIR}/${name}`, "utf8")
    } catch {
      continue // a missing file is precisely what the assertion below catches
    }

    for (const match of text.matchAll(REFERENCE_LIB)) queue.push(`lib.${match[1]}.d.ts`)
  }

  return requested
}

describe("browser LibSource — glob coverage", () => {
  it("globs every lib the chain-walk can request from the default lib", () => {
    // Arrange
    const requested = namesRequestedByChainWalk(DEFAULT_LIB)

    // Act
    const missing = requested.filter((name) => !GLOBBED_LIB_NAMES.has(name))

    // Assert — a missing name means the webview builds a lib-less program in silence.
    expect(missing).toEqual([])
    expect(requested.length).toBeGreaterThan(1)
  })

  it("includes the default lib itself", () => {
    // Arrange / Act / Assert
    expect(GLOBBED_LIB_NAMES.has(DEFAULT_LIB)).toBe(true)
  })
})
