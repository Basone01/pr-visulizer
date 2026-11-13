// An assistant message is markdown prose with rich blocks fenced as ```openui-lang.
// Only that exact tag makes a block, so every other fenced block (```ts, ```mermaid, …) stays
// inside the prose for the markdown renderer.

export type MessageSegment =
  | { kind: "prose"; text: string }
  // closed is false while a streaming message has opened the fence but not finished it yet.
  | { kind: "openui"; code: string; closed: boolean }

const OPENUI_FENCE_TAG = "openui-lang"
const OPENING_FENCE = /^(`{3,}|~{3,})(.*)$/
// A last line that may still grow into an openui-lang opener, such as "```" or "```open".
const UNFINISHED_OPENER = /^(?:`{3,}|~{3,})([\w-]*)$/

type OpenFence = {
  marker: string
  isOpenUi: boolean
}

export function splitMessageSegments(
  message: string,
  options: { streaming: boolean }
): MessageSegment[] {
  const segments: MessageSegment[] = []
  let proseLines: string[] = []
  let openUiLines: string[] = []
  let fence: OpenFence | null = null

  function flushProse(): void {
    const text = proseLines.join("\n")
    if (text.trim() !== "") segments.push({ kind: "prose", text })
    proseLines = []
  }

  const lines = message.replace(/\r\n?/g, "\n").split("\n")
  for (const [index, line] of lines.entries()) {
    if (fence === null) {
      // Held back until its newline arrives: shown early, "```open" renders as an empty code
      // block that turns into a card a few tokens later.
      const isLastLine = index === lines.length - 1
      if (options.streaming && isLastLine && couldBecomeOpenUiOpener(line)) break

      fence = openingFence(line)
      if (fence?.isOpenUi) {
        flushProse()
        openUiLines = []
        continue
      }

      proseLines.push(line)
      continue
    }

    if (isClosingFence(line, fence)) {
      if (fence.isOpenUi)
        segments.push({ kind: "openui", code: openUiLines.join("\n"), closed: true })
      else proseLines.push(line)
      fence = null
      continue
    }

    if (fence.isOpenUi) openUiLines.push(line)
    else proseLines.push(line)
  }

  flushProse()
  if (fence?.isOpenUi)
    segments.push({ kind: "openui", code: openUiLines.join("\n"), closed: false })

  return segments
}

function couldBecomeOpenUiOpener(line: string): boolean {
  const infoString = UNFINISHED_OPENER.exec(line)?.[1]
  return infoString !== undefined && OPENUI_FENCE_TAG.startsWith(infoString)
}

function openingFence(line: string): OpenFence | null {
  const match = OPENING_FENCE.exec(line)
  const marker = match?.[1]
  if (marker === undefined) return null

  const infoString = (match?.[2] ?? "").trim()
  return { marker, isOpenUi: infoString === OPENUI_FENCE_TAG }
}

// CommonMark: the closing fence uses the same character, at least as many times, and nothing else.
function isClosingFence(line: string, fence: OpenFence): boolean {
  const candidate = line.trimEnd()
  const fenceCharacter = fence.marker.charAt(0)
  const isOnlyFenceCharacters = [...candidate].every((character) => character === fenceCharacter)

  return isOnlyFenceCharacters && candidate.length >= fence.marker.length
}
