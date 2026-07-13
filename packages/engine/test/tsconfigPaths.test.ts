import { describe, expect, it } from "vitest"

import { resolveToKnownPath } from "../src/utils/modulePath.js"
import { aliasCandidateBases, buildAliasTable } from "../src/utils/tsconfigPaths.js"

// tsconfig `paths` resolution. The case that shapes the design, taken from a real monorepo
// (wisesight/analytics-suite): SEVERAL tsconfigs each map the SAME `@/*` alias to their OWN
// src root, so an importing file must resolve against the NEAREST ancestor tsconfig.

// `web` sets baseUrl and a bare "*" target; `zem-web` sets no baseUrl and a "./src/*" target.
// The two spellings must land on the same place — TS resolves targets against baseUrl when
// present, else against the tsconfig's own directory.
const webTsconfig = `{
  "compilerOptions": {
    // absolute imports
    "baseUrl": "./src/",
    "paths": { "@/*": ["*"] },
  }
}`

const zemWebTsconfig = `{
  "compilerOptions": {
    "paths": { "@/*": ["./src/*"] }
  }
}`

describe("buildAliasTable — several tsconfigs, same alias, different roots", () => {
  it("expands @/ against the nearest ancestor tsconfig, not a global table", () => {
    // Arrange
    const contents = new Map([
      ["web/tsconfig.json", webTsconfig],
      ["zem-web/tsconfig.json", zemWebTsconfig],
    ])
    const specifier = "@/components/Chart"
    const webImporter = "web/src/pages/dashboard.tsx"
    const zemWebImporter = "zem-web/src/pages/home.tsx"

    // Act
    const table = buildAliasTable(contents)
    const fromWeb = aliasCandidateBases(webImporter, specifier, table)
    const fromZemWeb = aliasCandidateBases(zemWebImporter, specifier, table)

    // Assert — the same specifier resolves to two different roots.
    const expectedFromWeb = ["web/src/components/Chart"]
    const expectedFromZemWeb = ["zem-web/src/components/Chart"]
    expect(fromWeb).toEqual(expectedFromWeb)
    expect(fromZemWeb).toEqual(expectedFromZemWeb)
  })

  it("leaves a bare package specifier unaliased so it stays external", () => {
    // Arrange
    const contents = new Map([["web/tsconfig.json", webTsconfig]])
    const packageSpecifier = "react"
    const importer = "web/src/pages/dashboard.tsx"

    // Act
    const bases = aliasCandidateBases(importer, packageSpecifier, buildAliasTable(contents))

    // Assert
    expect(bases).toEqual([])
  })

  it("does not apply an alias to a file outside the declaring tsconfig's directory", () => {
    // Arrange — the importer sits in a sibling project with no tsconfig of its own.
    const contents = new Map([["web/tsconfig.json", webTsconfig]])
    const specifier = "@/components/Chart"
    const outsideImporter = "worker/src/job.ts"

    // Act
    const bases = aliasCandidateBases(outsideImporter, specifier, buildAliasTable(contents))

    // Assert
    expect(bases).toEqual([])
  })
})

describe("resolveToKnownPath — aliased specifiers", () => {
  it("resolves an aliased import to a real repo file, extension-less and via index", () => {
    // Arrange
    const contents = new Map([["web/tsconfig.json", webTsconfig]])
    const table = buildAliasTable(contents)
    const importer = "web/src/pages/dashboard.tsx"
    const knownPaths = new Set(["web/src/components/Chart.tsx", "web/src/lib/http/index.ts"])

    // Act
    const directHit = resolveToKnownPath(importer, "@/components/Chart", knownPaths, table)
    const indexHit = resolveToKnownPath(importer, "@/lib/http", knownPaths, table)
    const missing = resolveToKnownPath(importer, "@/nope/Absent", knownPaths, table)

    // Assert
    expect(directHit).toBe("web/src/components/Chart.tsx")
    expect(indexHit).toBe("web/src/lib/http/index.ts")
    expect(missing).toBeNull()
  })

  it("keeps relative resolution identical when no alias table is supplied", () => {
    // Arrange — the fast engine calls it this way; behaviour must not change.
    const importer = "src/api/routes/login.ts"
    const knownPaths = new Set(["src/middleware/withRateLimit.ts"])

    // Act
    const relative = resolveToKnownPath(importer, "../../middleware/withRateLimit.js", knownPaths)
    const aliased = resolveToKnownPath(importer, "@/middleware/withRateLimit", knownPaths)

    // Assert — an alias without a table stays unresolved (external), as before.
    expect(relative).toBe("src/middleware/withRateLimit.ts")
    expect(aliased).toBeNull()
  })
})
