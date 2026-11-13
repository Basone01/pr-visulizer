import type { ChangeKind } from "./diagramModel"
import type { FlowDiagram } from "./flowDiagram"
import type { SequenceDiagram } from "./sequenceDiagram"

// The ledger: one row per object whose change is not "unchanged". Nodes (or participants) first,
// then relationships (or messages) as "A → B". It is also the text alternative of the picture.

export type LedgerEntry = {
  key: string
  change: Exclude<ChangeKind, "unchanged">
  name: string
  note: string | null
  path: string | null
  line: number | null
}

type Changed<T extends { change: ChangeKind }> = T & { change: Exclude<ChangeKind, "unchanged"> }

function isChanged<T extends { change: ChangeKind }>(item: T): item is Changed<T> {
  return item.change !== "unchanged"
}

export function flowLedgerEntries(diagram: FlowDiagram): LedgerEntry[] {
  const labelOf = new Map(diagram.nodes.map((node) => [node.id, node.label]))

  const nodeEntries = diagram.nodes.filter(isChanged).map((node) => ({
    key: `node-${node.id}`,
    change: node.change,
    name: node.label,
    note: node.note,
    path: node.path,
    line: node.line,
  }))
  const edgeEntries = diagram.edges.filter(isChanged).map((edge) => ({
    key: edge.id,
    change: edge.change,
    name: `${labelOf.get(edge.from) ?? edge.from} → ${labelOf.get(edge.to) ?? edge.to}`,
    note: edge.label,
    path: null,
    line: null,
  }))

  return [...nodeEntries, ...edgeEntries]
}

export function sequenceLedgerEntries(sequence: SequenceDiagram): LedgerEntry[] {
  const labelOf = new Map(
    sequence.participants.map((participant) => [participant.id, participant.label])
  )

  const participantEntries = sequence.participants.filter(isChanged).map((participant) => ({
    key: `participant-${participant.id}`,
    change: participant.change,
    name: participant.label,
    note: null,
    path: null,
    line: null,
  }))
  const messageEntries = sequence.messages.filter(isChanged).map((message) => ({
    key: message.id,
    change: message.change,
    name: `${labelOf.get(message.from) ?? message.from} → ${labelOf.get(message.to) ?? message.to}`,
    note: message.label || null,
    path: null,
    line: null,
  }))

  return [...participantEntries, ...messageEntries]
}

// "A → B (label)" for every relationship, with the full label: the plain fallback when the picture cannot be drawn.
export function flowRelationshipLines(diagram: FlowDiagram): string[] {
  const labelOf = new Map(diagram.nodes.map((node) => [node.id, node.label]))

  return diagram.edges.map((edge) => {
    const line = `${labelOf.get(edge.from) ?? edge.from} → ${labelOf.get(edge.to) ?? edge.to}`
    return edge.label ? `${line} (${edge.label})` : line
  })
}
