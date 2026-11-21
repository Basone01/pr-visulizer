import type { DiffLine, ParsedDiff } from "@/entity/diff"

import { pairChangedLines } from "./pairChangedLines"

// The side-by-side view model (§10), JetBrains style: each side is its own continuous file, with
// NO filler rows, and every change is a BLOCK that names the left lines it replaced and the right
// lines it became. The view draws a ribbon between those two ranges, so a 1-line "before" and a
// 2-line "after" stay visibly joined even though they sit at different heights.
//
// Like the other transforms it is pure and chains after full-file and hide-whitespace. Every cell
// is the SAME DiffLine the parse produced, so anchors, drafts and find keep resolving off it.

// A cell keeps the line's index in the flat ParsedDiff. Find, the flash and the progressive mount
// budget all address lines by that index.
export type SplitCell = {
  line: DiffLine
  index: number
}

// Half-open [start, end) into one side's cell list. An empty range (start === end) is the point
// BETWEEN two lines where the other side's lines were inserted or removed.
export type LineRange = { start: number; end: number }

// modified: lines on both sides. inserted: right only. deleted: left only.
export type ChangeKind = "modified" | "inserted" | "deleted"

export type ChangeBlock = {
  kind: ChangeKind
  left: LineRange
  right: LineRange
}

export type SplitView = {
  left: SplitCell[]
  right: SplitCell[]
  blocks: ChangeBlock[]
}

// One step through a change region, in file order: a similar del/add pair, or a lone line.
type RegionStep = "pair" | "del" | "add"

// Walk one del-run and the add-run after it through the SAME similarity pairing the word-level
// emphasis uses, so a block never joins two lines the emphasis says are unrelated.
// Both runs stay in order: an addition that comes before its partner's pair is a lone insertion.
function regionSteps(dels: SplitCell[], adds: SplitCell[]): RegionStep[] {
  const pairs = pairChangedLines(
    dels.map((cell) => cell.line.content),
    adds.map((cell) => cell.line.content)
  )
  const addForDel = new Map(pairs.map(({ delIndex, addIndex }) => [delIndex, addIndex]))

  const steps: RegionStep[] = []
  let delIndex = 0
  let addIndex = 0

  while (delIndex < dels.length || addIndex < adds.length) {
    if (delIndex >= dels.length) {
      steps.push("add")
      addIndex += 1
      continue
    }

    const partner = addForDel.get(delIndex)

    if (partner === addIndex) {
      steps.push("pair")
      delIndex += 1
      addIndex += 1
      continue
    }

    if (partner === undefined) {
      steps.push("del")
      delIndex += 1
      continue
    }

    steps.push("add")
    addIndex += 1
  }

  return steps
}

// Cut the steps into blocks where a run of pairs meets a run of lone lines. That is why the
// reference case reads as TWO blocks: "@MainActor" inserted, then "class FrameStore {" modified.
// A run of lone lines with BOTH dels and adds (a rewrite nothing pairs up) is one modified block.
function groupSteps(steps: RegionStep[]): RegionStep[][] {
  const groups: RegionStep[][] = []

  for (const step of steps) {
    const group = groups.at(-1)
    const isSameRun = group !== undefined && (group[0] === "pair") === (step === "pair")

    if (isSameRun) group.push(step)
    else groups.push([step])
  }

  return groups
}

function kindOf(delCount: number, addCount: number): ChangeKind {
  if (delCount === 0) return "inserted"
  if (addCount === 0) return "deleted"

  return "modified"
}

export function buildSplitView(parsed: ParsedDiff): SplitView {
  const { lines } = parsed
  const view: SplitView = { left: [], right: [], blocks: [] }

  let index = 0
  while (index < lines.length) {
    const cell: SplitCell = { line: lines[index]!, index }

    // A hunk header and a context line belong to both files: the same cell on each side.
    if (cell.line.kind === "hunk" || cell.line.kind === "context") {
      view.left.push(cell)
      view.right.push(cell)
      index += 1
      continue
    }

    // A change region: the maximal del-run, then the add-run right after it. A pure-addition
    // region enters with an empty del-run.
    const dels: SplitCell[] = []
    while (index < lines.length && lines[index]!.kind === "del") {
      dels.push({ line: lines[index]!, index })
      index += 1
    }

    const adds: SplitCell[] = []
    while (index < lines.length && lines[index]!.kind === "add") {
      adds.push({ line: lines[index]!, index })
      index += 1
    }

    let delCursor = 0
    let addCursor = 0

    for (const group of groupSteps(regionSteps(dels, adds))) {
      const delCount = group.filter((step) => step !== "add").length
      const addCount = group.filter((step) => step !== "del").length

      const left = { start: view.left.length, end: view.left.length + delCount }
      const right = { start: view.right.length, end: view.right.length + addCount }
      view.blocks.push({ kind: kindOf(delCount, addCount), left, right })

      view.left.push(...dels.slice(delCursor, delCursor + delCount))
      view.right.push(...adds.slice(addCursor, addCursor + addCount))
      delCursor += delCount
      addCursor += addCount
    }
  }

  return view
}
