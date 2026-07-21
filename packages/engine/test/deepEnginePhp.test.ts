import { describe, expect, it } from "vitest"

import { createDeepEngine, createFakeGithubGateway, createInMemoryRepoFiles } from "../src/index.js"
import { createNodeGrammarSource } from "../src/node.js"

// Deep-engine repo-wide resolution for PHP (docs/architecture.md §6): a PSR-4-style layout where
// the namespace root `App\` maps to `src/` (which we cannot read from composer.json). A CHANGED
// class is referenced by a CHANGED service (via `use` + `Class::method` + a typed parameter) and
// by an UNCHANGED handler. Fast mode sees only a changed file's own `use`s; deep mode indexes the
// whole checkout and surfaces the unchanged handler as a ghost.

const USER_PATH = "src/Model/User.php"
const WIDGET_PATH = "src/Service/Widget.php"
const HANDLER_PATH = "src/Api/Handler.php"

const USER_ID = `${USER_PATH}#User`
const CREATE_ID = `${USER_PATH}#create`
const BUILD_ID = `${WIDGET_PATH}#build`

// User.php defines class User + static create (CHANGED). Widget.php (CHANGED) uses User as a
// parameter type and calls User::create. Handler.php (UNCHANGED) does `new User()` + User::create.
const userSource = `<?php
namespace App\\Model;

class User {
    public static function create(): int {
        return 1;
    }
}
`
const widgetSource = `<?php
namespace App\\Service;

use App\\Model\\User;

function build(User $u): int {
    return User::create();
}
`
const handlerSource = `<?php
namespace App\\Api;

use App\\Model\\User;

function handle(): int {
    $u = new User();
    return User::create();
}
`

const meta = {
  owner: "acme",
  repo: "phpservice",
  number: 21,
  title: "tweak User::create",
  author: "contributor-dev",
  baseSha: "basephp0001",
  headSha: "headphp0001",
}

const target = { owner: meta.owner, repo: meta.repo, number: meta.number }

// Only User.php + Widget.php changed; Handler.php is unchanged repo context.
const changedFiles = [
  {
    path: USER_PATH,
    status: "modified" as const,
    additions: 1,
    deletions: 0,
    language: "php",
    patch: "@@ -5,1 +5,1 @@\n",
  },
  {
    path: WIDGET_PATH,
    status: "added" as const,
    additions: 7,
    deletions: 0,
    language: "php",
    patch: "@@ -0,0 +1,7 @@\n",
  },
]

function buildPhpDeepEngine() {
  const gateway = createFakeGithubGateway([
    {
      meta,
      files: changedFiles,
      contents: { [USER_PATH]: userSource, [WIDGET_PATH]: widgetSource },
    },
  ])
  const repoFiles = createInMemoryRepoFiles({
    [USER_PATH]: userSource,
    [WIDGET_PATH]: widgetSource,
    [HANDLER_PATH]: handlerSource,
  })

  return createDeepEngine({ gateway, repoFiles, grammarSource: createNodeGrammarSource() })
}

describe("createDeepEngine — PHP use-binding + static call + typed parameter", () => {
  it("links the changed files with a file edge and call + uses-type symbol edges", async () => {
    // Arrange
    const engine = buildPhpDeepEngine()
    const expectedFileEdge = {
      from: WIDGET_PATH,
      to: USER_PATH,
      kind: "imports",
      level: "file",
      source: "ast",
    }
    const expectedCallEdge = {
      from: BUILD_ID,
      to: CREATE_ID,
      kind: "calls",
      level: "symbol",
      source: "ast",
    }
    const expectedTypeEdge = {
      from: BUILD_ID,
      to: USER_ID,
      kind: "uses-type",
      level: "symbol",
      source: "ast",
    }

    // Act
    const result = await engine.analyze(target)
    const fileEdge = result.edges.find(
      (edge) => edge.level === "file" && edge.from === WIDGET_PATH && edge.to === USER_PATH
    )
    const callEdge = result.edges.find((edge) => edge.from === BUILD_ID && edge.to === CREATE_ID)
    const typeEdge = result.edges.find((edge) => edge.from === BUILD_ID && edge.to === USER_ID)

    // Assert — the `use App\Model\User` bound `User` to src/Model/User.php by namespace-suffix.
    expect({ fileEdge, callEdge, typeEdge }).toEqual({
      fileEdge: expectedFileEdge,
      callEdge: expectedCallEdge,
      typeEdge: expectedTypeEdge,
    })
  })

  it("emits the unchanged handler as a ghost and reports blastRadius 1 on the changed class", async () => {
    // Arrange
    const engine = buildPhpDeepEngine()
    const expectedGhosts = { [HANDLER_PATH]: [USER_ID, CREATE_ID] }
    const expectedBlastRadius = 1

    // Act
    const result = await engine.analyze(target)
    const ghostMap = Object.fromEntries(
      result.ghosts.map((ghost) => [ghost.path, ghost.usedChangedSymbols])
    )
    const userRanked = result.ranking.find((ranked) => ranked.path === USER_PATH)

    // Assert — Handler.php's `new User()` + `User::create()` resolved to the changed symbols
    // though Handler.php never changed (usedChangedSymbols is sorted).
    expect({ ghostMap, blastRadius: userRanked?.blastRadius }).toEqual({
      ghostMap: expectedGhosts,
      blastRadius: expectedBlastRadius,
    })
  })

  it("resolves a relative require between two changed files as a file edge", async () => {
    // Arrange — a.php (changed) require()s its sibling b.php (changed) with a relative path.
    const helperPath = "lib/a.php"
    const siblingPath = "lib/b.php"
    const aSource = `<?php\nrequire "./b.php";\n\nfunction a(): int {\n    return 1;\n}\n`
    const bSource = `<?php\n\nfunction b(): int {\n    return 2;\n}\n`
    const requireMeta = {
      owner: "acme",
      repo: "phplib",
      number: 22,
      title: "require sibling",
      author: "someone",
      baseSha: "baseph0002",
      headSha: "headph0002",
    }
    const files = [
      {
        path: helperPath,
        status: "added" as const,
        additions: 6,
        deletions: 0,
        language: "php",
        patch: "@@ -0,0 +1,6 @@\n",
      },
      {
        path: siblingPath,
        status: "added" as const,
        additions: 4,
        deletions: 0,
        language: "php",
        patch: "@@ -0,0 +1,4 @@\n",
      },
    ]
    const gateway = createFakeGithubGateway([
      { meta: requireMeta, files, contents: { [helperPath]: aSource, [siblingPath]: bSource } },
    ])
    const repoFiles = createInMemoryRepoFiles({ [helperPath]: aSource, [siblingPath]: bSource })
    const engine = createDeepEngine({
      gateway,
      repoFiles,
      grammarSource: createNodeGrammarSource(),
    })
    const expectedFileEdge = {
      from: helperPath,
      to: siblingPath,
      kind: "imports",
      level: "file",
      source: "ast",
    }

    // Act
    const result = await engine.analyze({
      owner: requireMeta.owner,
      repo: requireMeta.repo,
      number: requireMeta.number,
    })
    const fileEdge = result.edges.find(
      (edge) => edge.level === "file" && edge.from === helperPath && edge.to === siblingPath
    )

    // Assert
    expect(fileEdge).toEqual(expectedFileEdge)
  })
})
