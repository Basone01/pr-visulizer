import {
  type ChangeKind,
  type NodeKind,
  type RawRecord,
  TEXT_BUDGETS,
  capNotice,
  readChange,
  readLine,
  readNodeKind,
  readOptionalText,
  readRecords,
  readText,
} from "./diagramModel"

// A component diagram of what a PR touches: nodes, the relationships between them,
// optional groups, and what the PR did to each.

export type FlowNode = {
  id: string
  label: string
  change: ChangeKind
  note: string | null
  path: string | null
  // The line to open the file at, when the path came with one (a FileRef with a line).
  line: number | null
  kind: NodeKind
}

export type FlowEdge = {
  id: string
  from: string
  to: string
  label: string | null
  change: ChangeKind
}

export type FlowGroup = {
  id: string
  label: string
  nodeIds: string[]
}

export type FlowDiagram = {
  title: string
  nodes: FlowNode[]
  edges: FlowEdge[]
  groups: FlowGroup[]
  // Visible lines about what was left out, e.g. "Showing 16 of 23 components".
  notices: string[]
}

// Hard render caps. The agent is taught smaller budgets (8 nodes, 10 edges).
export const FLOW_LIMITS = { nodes: 16, edges: 24 } as const

// What the agent sent, as OpenUI hands it over: the props of Diagram and of its children.
export type RawFlowDiagram = {
  title: unknown
  nodes: unknown
  edges: unknown
  groups: unknown
}

// Tolerance rules: an edge to an unknown id creates a plain node with that id as its label,
// a duplicate id keeps the first, a group member that does not exist is ignored, and an unknown
// change or kind falls back to the default. Past a cap, the first N are kept and a notice says so.
export function normalizeFlowDiagram(raw: RawFlowDiagram): FlowDiagram {
  const declaredNodes = readNodes(raw.nodes)
  const declaredEdges = readEdges(raw.edges)
  // Only an edge inside the cap can create a node: one past it is never drawn, and its endpoint
  // would be a box with no connection.
  const allNodes = withImplicitNodes(declaredNodes, declaredEdges.slice(0, FLOW_LIMITS.edges))

  const nodes = allNodes.slice(0, FLOW_LIMITS.nodes)
  const keptIds = new Set(nodes.map((node) => node.id))
  const drawableEdges = declaredEdges.filter(
    (edge) => keptIds.has(edge.from) && keptIds.has(edge.to)
  )
  const edges = drawableEdges.slice(0, FLOW_LIMITS.edges)
  const groups = readGroups(raw.groups, keptIds)

  const nodeNotice = capNotice(nodes.length, allNodes.length, "components")
  const edgeNotice = capNotice(edges.length, declaredEdges.length, "relationships")

  return {
    title: readText(raw.title, TEXT_BUDGETS.title) || "Diagram",
    nodes,
    edges,
    groups,
    notices: [nodeNotice, edgeNotice].filter((notice): notice is string => notice !== null),
  }
}

function readNodes(value: unknown): FlowNode[] {
  const nodes: FlowNode[] = []
  const seenIds = new Set<string>()

  for (const record of readRecords(value)) {
    const id = readText(record["id"], TEXT_BUDGETS.id)
    if (!id || seenIds.has(id)) continue

    seenIds.add(id)
    nodes.push({
      id,
      label: readText(record["label"], TEXT_BUDGETS.label) || id,
      change: readChange(record["change"]),
      note: readOptionalText(record["note"], TEXT_BUDGETS.note),
      path: readOptionalText(record["path"], TEXT_BUDGETS.path),
      line: readLine(record["line"]),
      kind: readNodeKind(record["kind"]),
    })
  }

  return nodes
}

function readEdges(value: unknown): FlowEdge[] {
  const edges: FlowEdge[] = []

  for (const record of readRecords(value)) {
    const from = readText(record["from"], TEXT_BUDGETS.id)
    const to = readText(record["to"], TEXT_BUDGETS.id)
    if (!from || !to) continue

    edges.push({
      id: `edge-${edges.length}`,
      from,
      to,
      label: readOptionalText(record["label"], TEXT_BUDGETS.label),
      change: readChange(record["change"]),
    })
  }

  return edges
}

// An edge endpoint nobody declared becomes a plain node, in the order the edges name them.
function withImplicitNodes(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] {
  const allNodes = [...nodes]
  const knownIds = new Set(nodes.map((node) => node.id))

  for (const endpoint of edges.flatMap((edge) => [edge.from, edge.to])) {
    if (knownIds.has(endpoint)) continue

    knownIds.add(endpoint)
    allNodes.push(plainNode(endpoint))
  }

  return allNodes
}

function plainNode(id: string): FlowNode {
  return {
    id,
    label: id,
    change: "unchanged",
    note: null,
    path: null,
    line: null,
    kind: "component",
  }
}

// A node belongs to at most one group (the first that lists it), and empty groups are dropped:
// groups are laid out as containers, and a box cannot sit in two of them.
function readGroups(value: unknown, keptIds: Set<string>): FlowGroup[] {
  const groups: FlowGroup[] = []
  const groupedIds = new Set<string>()

  for (const record of readRecords(value)) {
    const memberIds = readIdList(record["nodeIds"]).filter(
      (id) => keptIds.has(id) && !groupedIds.has(id)
    )
    if (memberIds.length === 0) continue

    memberIds.forEach((id) => groupedIds.add(id))
    groups.push({
      id: `group-${groups.length}`,
      label: readText(record["label"], TEXT_BUDGETS.label) || "Group",
      nodeIds: memberIds,
    })
  }

  return groups
}

function readIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const ids = value.map((item) => readText(item, TEXT_BUDGETS.id)).filter((id) => id !== "")
  return [...new Set(ids)]
}

export function nodeById(diagram: FlowDiagram): Map<string, FlowNode> {
  return new Map(diagram.nodes.map((node) => [node.id, node]))
}
