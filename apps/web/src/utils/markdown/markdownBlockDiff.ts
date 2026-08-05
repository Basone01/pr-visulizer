// The rendered-markdown diff's core (§10, experimental): compare two revisions of a markdown
// document as a sequence of BLOCKS, so the result can be re-rendered as prose rather than as
// lines. A line diff is the wrong unit here — reflowing one sentence rewrites every line of its
// paragraph, and a rendered view has no line numbers to hang the difference on.
//
// Pure and framework-free: it takes two strings and returns blocks with a status. Every
// rendering decision (what a removed block looks like) belongs to the component.

export type MarkdownBlockStatus = "added" | "removed" | "unchanged"

export type MarkdownBlock = {
  status: MarkdownBlockStatus
  // The block's own markdown, ready to hand to the renderer as a standalone document.
  source: string
}

// A fence opens with ``` or ~~~ (up to three leading spaces, per CommonMark) and closes with the
// same character, at least as long. Everything between is ONE block however many blank lines it
// contains — splitting there would cut a code sample in half and each half would re-render as
// something else entirely.
const FENCE = /^ {0,3}(`{3,}|~{3,})/

type Fence = { char: string; length: number }

function fenceOf(line: string): Fence | null {
  const marker = FENCE.exec(line)?.[1]
  if (!marker) return null

  return { char: marker[0]!, length: marker.length }
}

function closes(open: Fence, line: string): boolean {
  const fence = fenceOf(line)

  return fence !== null && fence.char === open.char && fence.length >= open.length
}

// Blank-line separated blocks, with fences kept whole. A fence also ends the block before it and
// stands alone afterwards: markdown treats it as its own leaf, and keeping that true here means a
// code sample can never be merged into the paragraph that introduces it.
export function splitMarkdownBlocks(source: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let openFence: Fence | null = null

  function flush(): void {
    if (current.length === 0) return

    blocks.push(current.join("\n"))
    current = []
  }

  for (const line of source.split("\n")) {
    if (openFence) {
      current.push(line)
      if (closes(openFence, line)) {
        openFence = null
        flush()
      }
      continue
    }

    const fence = fenceOf(line)
    if (fence) {
      flush()
      openFence = fence
      current.push(line)
      continue
    }

    if (line.trim() === "") {
      flush()
      continue
    }

    current.push(line)
  }

  // An unterminated fence (a truncated document) still yields its block rather than vanishing.
  flush()

  return blocks
}

// Longest common subsequence lengths over the two block sequences. Blocks per document are in
// the tens, so the plain O(n·m) table is the right amount of machinery — and it keeps the
// backtrack below readable, which matters more here than shaving a table nobody will notice.
function lcsTable(base: string[], head: string[]): number[][] {
  const table: number[][] = Array.from({ length: base.length + 1 }, () =>
    new Array<number>(head.length + 1).fill(0)
  )

  for (let i = base.length - 1; i >= 0; i -= 1) {
    for (let j = head.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        base[i] === head[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }

  return table
}

// Diff two markdown revisions block by block. Unchanged blocks appear once; a changed region
// lists what was REMOVED before what was ADDED, which is the order a reviewer reads a rewrite in
// (and the order GitHub's rich diff uses).
export function diffMarkdownBlocks(baseText: string, headText: string): MarkdownBlock[] {
  const base = splitMarkdownBlocks(baseText)
  const head = splitMarkdownBlocks(headText)
  const table = lcsTable(base, head)

  const blocks: MarkdownBlock[] = []
  let i = 0
  let j = 0

  while (i < base.length && j < head.length) {
    if (base[i] === head[j]) {
      blocks.push({ status: "unchanged", source: base[i]! })
      i += 1
      j += 1
      continue
    }

    // Off the LCS: drop the side that keeps the longer common subsequence ahead of it, and emit
    // the removal first on a tie so a replaced block reads base-then-head.
    if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      blocks.push({ status: "removed", source: base[i]! })
      i += 1
      continue
    }

    blocks.push({ status: "added", source: head[j]! })
    j += 1
  }

  // Whatever is left ran past the end of the other side.
  for (; i < base.length; i += 1) blocks.push({ status: "removed", source: base[i]! })
  for (; j < head.length; j += 1) blocks.push({ status: "added", source: head[j]! })

  return blocks
}
