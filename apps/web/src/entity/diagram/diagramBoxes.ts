import type { LayeredEdge, LayeredGraph } from "@/utils/diagram/layeredLayout"
import type { SequenceColumnInput, SequenceRowInput } from "@/utils/diagram/sequenceLayout"
import { estimateTextWidth, snapUp, wrapText } from "@/utils/diagram/textMetrics"

import { EDGE_LABEL_MAX_CHARS, type NodeKind, truncateText } from "./diagramModel"
import type { FlowDiagram, FlowEdge } from "./flowDiagram"
import type { SequenceDiagram } from "./sequenceDiagram"

// What each diagram object occupies, decided once: the layout is fed these sizes and the view
// draws these lines, so the two can never disagree about how big a box is.

// ---------- Flow nodes ----------

// A node is as wide as its own content (name, file name, kind tag), on the 4 px grid and within
// these bounds: identical wide boxes waste the narrow chat column and say nothing.
export const NODE_MIN_WIDTH = 96
export const NODE_MAX_WIDTH = 200
export const NODE_PADDING_X = 12
const NODE_PADDING_Y = 10
export const NAME_FONT_SIZE = 12
export const NAME_LINE_HEIGHT = 16
const NAME_MAX_LINES = 2
export const TAG_FONT_SIZE = 9
// Matches the tag's letter-spacing in Diagram.module.css.
const TAG_LETTER_SPACING_EM = 0.12
export const TAG_ROW_HEIGHT = 14
export const SUBLABEL_FONT_SIZE = 10
export const SUBLABEL_ROW_HEIGHT = 14
const MIN_NODE_HEIGHT = 40
// Names are drawn at weight 600, a little wider than the regular-weight estimate.
const BOLD_WIDTH_FACTOR = 1.06

const KIND_TAGS: Record<NodeKind, string | null> = {
  component: null,
  store: "STORE",
  external: "EXTERNAL",
}

export type FlowNodeBox = {
  id: string
  width: number
  height: number
  // Where the name starts, measured from the box top (content is centred in a taller box).
  nameTop: number
  nameLines: string[]
  nameTruncated: boolean
  tag: string | null
  sublabel: string | null
  sublabelTruncated: boolean
}

export function flowNodeBoxes(diagram: FlowDiagram): FlowNodeBox[] {
  const maxTextWidth = NODE_MAX_WIDTH - NODE_PADDING_X * 2

  return diagram.nodes.map((node) => {
    const tag = KIND_TAGS[node.kind]
    const name = wrapText(
      node.label,
      maxTextWidth / BOLD_WIDTH_FACTOR,
      NAME_FONT_SIZE,
      "sans",
      NAME_MAX_LINES
    )
    const basename = node.path === null ? null : fileBasename(node.path)
    const sublabel =
      basename === null ? null : wrapText(basename, maxTextWidth, SUBLABEL_FONT_SIZE, "mono", 1)

    const contentWidth = Math.max(
      ...name.lines.map(
        (line) => estimateTextWidth(line, NAME_FONT_SIZE, "sans") * BOLD_WIDTH_FACTOR
      ),
      ...(sublabel?.lines ?? []).map((line) => estimateTextWidth(line, SUBLABEL_FONT_SIZE, "mono")),
      tag ? tagWidth(tag) : 0
    )
    const width = clamp(snapUp(contentWidth + NODE_PADDING_X * 2), NODE_MIN_WIDTH, NODE_MAX_WIDTH)

    const tagHeight = tag ? TAG_ROW_HEIGHT : 0
    const contentHeight =
      tagHeight + name.lines.length * NAME_LINE_HEIGHT + (sublabel ? SUBLABEL_ROW_HEIGHT : 0)
    const height = Math.max(MIN_NODE_HEIGHT, snapUp(contentHeight + NODE_PADDING_Y * 2))

    return {
      id: node.id,
      width,
      height,
      nameTop: (height - contentHeight) / 2 + tagHeight,
      nameLines: name.lines,
      nameTruncated: name.truncated,
      tag,
      sublabel: sublabel?.lines[0] ?? null,
      sublabelTruncated: sublabel?.truncated ?? false,
    }
  })
}

function tagWidth(tag: string): number {
  return (
    estimateTextWidth(tag, TAG_FONT_SIZE, "mono") +
    tag.length * TAG_FONT_SIZE * TAG_LETTER_SPACING_EM
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function fileBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

// ---------- Flow edges and groups ----------

export const EDGE_LABEL_FONT_SIZE = 10
export const EDGE_LABEL_LINE_HEIGHT = 12
// Matches `.edgeLabel` letter-spacing in Diagram.module.css.
const EDGE_LABEL_LETTER_SPACING_EM = 0.06
export const EDGE_LABEL_PADDING_X = 4
const EDGE_LABEL_PADDING_Y = 2
// A label wraps between words, and after a "/" or "-", into lines about this wide, never
// narrower than its longest piece: one long chip beside every edge made the narrow,
// top-to-bottom layout a third wider, and "CREATE/UPDATE" is one word.
const EDGE_LABEL_WRAP_WIDTH = 60
// A changed edge's badge (16 px circle + 4 px gap) sits inside its label box, above the text, so
// elk reserves room for it and nothing is drawn over it. Above, not beside: in the narrow,
// top-to-bottom layout width is what runs out, height is cheap.
export const EDGE_BADGE_ROW = 20
const EDGE_BADGE_MIN_WIDTH = 16
export const GROUP_HEADER_HEIGHT = 28

// The label as drawn: cut to EDGE_LABEL_MAX_CHARS, upper case. The ledger keeps the full label.
export function edgeLabelText(label: string): string {
  return truncateText(label, EDGE_LABEL_MAX_CHARS).toUpperCase()
}

export type EdgeLabelBox = { lines: string[]; width: number; height: number }

// The label's lines and the box elk reserves for it, badge slot included for a changed edge.
export function edgeLabelBox(label: string, change: FlowEdge["change"]): EdgeLabelBox {
  const lines = wrapAtBreaks(edgeLabelText(label))
  const textWidth = Math.max(...lines.map(edgeLabelLineWidth))
  const hasBadge = change !== "unchanged"
  const contentWidth = Math.max(textWidth, hasBadge ? EDGE_BADGE_MIN_WIDTH : 0)

  return {
    lines,
    width: snapUp(contentWidth + EDGE_LABEL_PADDING_X * 2),
    height: snapUp(
      lines.length * EDGE_LABEL_LINE_HEIGHT +
        EDGE_LABEL_PADDING_Y * 2 +
        (hasBadge ? EDGE_BADGE_ROW : 0)
    ),
  }
}

// One piece of a label and what joins it to the piece before: a space between words, nothing
// after a "/" or "-" (the separator stays at the end of the first line).
type LabelPiece = { text: string; glue: "" | " " }

function wrapAtBreaks(text: string): string[] {
  const pieces: LabelPiece[] = text
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word, wordIndex) =>
      (word.match(/[^/-]+[/-]*|[/-]+/g) ?? [word]).map((part, partIndex) => ({
        text: part,
        glue: wordIndex > 0 && partIndex === 0 ? (" " as const) : ("" as const),
      }))
    )
  const maxWidth = Math.max(
    EDGE_LABEL_WRAP_WIDTH,
    ...pieces.map((piece) => edgeLabelLineWidth(piece.text))
  )

  const lines: string[] = []
  let current = ""
  for (const piece of pieces) {
    const joined = current ? `${current}${piece.glue}${piece.text}` : piece.text
    if (edgeLabelLineWidth(joined) <= maxWidth) {
      current = joined
      continue
    }

    lines.push(current)
    current = piece.text
  }
  if (current) lines.push(current)

  return lines
}

function edgeLabelLineWidth(line: string): number {
  return (
    estimateTextWidth(line, EDGE_LABEL_FONT_SIZE, "mono") +
    line.length * EDGE_LABEL_FONT_SIZE * EDGE_LABEL_LETTER_SPACING_EM
  )
}

export function flowLayeredGraph(diagram: FlowDiagram, boxes: FlowNodeBox[]): LayeredGraph {
  const groupOf = new Map<string, string>()
  for (const group of diagram.groups) {
    for (const nodeId of group.nodeIds) groupOf.set(nodeId, group.id)
  }

  return {
    boxes: boxes.map((box) => ({
      id: box.id,
      width: box.width,
      height: box.height,
      containerId: groupOf.get(box.id) ?? null,
    })),
    containers: diagram.groups.map((group) => ({
      id: group.id,
      headerHeight: GROUP_HEADER_HEIGHT,
    })),
    edges: diagram.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      label: edge.label === null ? null : edgeLabelSize(edge.label, edge.change),
    })),
  }
}

function edgeLabelSize(label: string, change: FlowEdge["change"]): LayeredEdge["label"] {
  const { width, height } = edgeLabelBox(label, change)
  return { text: edgeLabelText(label), width, height }
}

// ---------- Sequence ----------

export const PARTICIPANT_FONT_SIZE = 12
const PARTICIPANT_PADDING_X = 12
const PARTICIPANT_MIN_WIDTH = 72
const PARTICIPANT_MAX_WIDTH = 176
export const MESSAGE_FONT_SIZE = 10
// A message label is drawn cut to this many characters ("…" included), so one long label cannot
// push two lifelines a screen apart. The ledger and the label's <title> keep the full text.
const MESSAGE_LABEL_MAX_CHARS = 40

export function messageLabelText(label: string): string {
  return truncateText(label, MESSAGE_LABEL_MAX_CHARS)
}

export type ParticipantBox = { id: string; label: string; truncated: boolean; width: number }

export function participantBoxes(sequence: SequenceDiagram): ParticipantBox[] {
  const maxTextWidth = PARTICIPANT_MAX_WIDTH - PARTICIPANT_PADDING_X * 2

  return sequence.participants.map((participant) => {
    const wrapped = wrapText(
      participant.label,
      maxTextWidth / BOLD_WIDTH_FACTOR,
      PARTICIPANT_FONT_SIZE,
      "sans",
      1
    )
    const label = wrapped.lines[0] ?? participant.label
    const textWidth = estimateTextWidth(label, PARTICIPANT_FONT_SIZE, "sans") * BOLD_WIDTH_FACTOR

    return {
      id: participant.id,
      label,
      truncated: wrapped.truncated,
      width: snapUp(Math.max(PARTICIPANT_MIN_WIDTH, textWidth + PARTICIPANT_PADDING_X * 2)),
    }
  })
}

export function sequenceLayoutInput(
  sequence: SequenceDiagram,
  boxes: ParticipantBox[]
): { columns: SequenceColumnInput[]; rows: SequenceRowInput[] } {
  const columnOf = new Map(
    sequence.participants.map((participant, index) => [participant.id, index])
  )

  return {
    columns: boxes.map((box) => ({ headerWidth: box.width })),
    rows: sequence.messages.map((message) => ({
      from: columnOf.get(message.from) ?? 0,
      to: columnOf.get(message.to) ?? 0,
      labelWidth: estimateTextWidth(messageLabelText(message.label), MESSAGE_FONT_SIZE, "mono"),
    })),
  }
}
