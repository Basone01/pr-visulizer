import { defineComponent, tagSchemaId, useIsStreaming } from "@openuidev/react-lang"
import { type ReactNode, useCallback, useContext, useMemo, useRef } from "react"
import { z } from "zod"

import { CHANGE_KINDS, NODE_KINDS } from "@/entity/diagram/diagramModel"
import { type RawFlowDiagram, normalizeFlowDiagram } from "@/entity/diagram/flowDiagram"
import { type RawSequenceDiagram, normalizeSequenceDiagram } from "@/entity/diagram/sequenceDiagram"

import { DiagramView } from "@/components/diagram/DiagramView"
import { SequenceDiagramView } from "@/components/diagram/SequenceDiagramView"

import { normalizeFileRefPath } from "./blockActions"
import { BlockHostContext } from "./blockHost"
import { FileRef } from "./reviewComponents"

// Diagrams in chat: the agent sends data (nodes, edges, what the PR did to each), never markup or
// coordinates. These wrappers only hand OpenUI's parsed props to the app's own diagram views.
// Child components (DiagramNode, …) render nothing: their parent reads their props.
//
// The schemas are deliberately lenient: OpenUI drops a whole component when a field fails its
// schema, before the readers' tolerance rules (entity/diagram) can run. Facts from lang-core
// 1.1.0 this relies on: prompt signatures are printed from the zod schema, a field's JSON schema
// does the checking, a union (anyOf) is not type-checked, a top-level JSON "default" fills a null
// or missing argument, and `.catch(x)` emits that default while staying required in the prompt.
// tagSchemaId only changes the printed type. So the agent reads exact, required signatures,
// and a null, a number or a single item still reaches the readers.

function printedAs<T extends z.ZodType>(schema: T, printedType: string): T {
  tagSchemaId(schema, printedType)
  return schema
}

const scalar = () => z.union([z.string(), z.number(), z.boolean()])
// Required text: prints "string", a null or missing value arrives as "".
const requiredText = () => printedAs(scalar().catch(""), "string")
const optionalText = () => printedAs(scalar(), "string").optional()
const printedChanges = CHANGE_KINDS.map((change) => `"${change}"`).join(" | ")
const changeSchema = () => printedAs(scalar(), printedChanges).optional()

// A list that also takes a single item or nothing at all.
function listOf(item: z.core.$ZodType, printedType: string) {
  return printedAs(z.union([z.array(item), item]).catch([]), printedType)
}

export const DiagramNode = defineComponent({
  name: "DiagramNode",
  props: z.object({
    id: requiredText(),
    label: requiredText(),
    change: changeSchema(),
    note: optionalText(),
    // A FileRef here works too (its line is kept): models used to FileRef for files write one.
    path: printedAs(z.union([z.string(), FileRef.ref]), "string").optional(),
    kind: printedAs(scalar(), NODE_KINDS.map((kind) => `"${kind}"`).join(" | ")).optional(),
  }),
  description: "A component the PR touches or needs (module, service, store, screen, job)",
  component: () => null,
})

export const DiagramEdge = defineComponent({
  name: "DiagramEdge",
  props: z.object({
    from: requiredText(),
    to: requiredText(),
    label: optionalText(),
    change: changeSchema(),
  }),
  description: "A relationship from one node id to another",
  component: () => null,
})

export const DiagramGroup = defineComponent({
  name: "DiagramGroup",
  props: z.object({
    label: requiredText(),
    // Ids, or the node statements themselves: both name the members.
    nodeIds: listOf(z.union([scalar(), DiagramNode.ref]), "string[]"),
  }),
  description: "A labelled zone around some nodes",
  component: () => null,
})

export const Diagram = defineComponent({
  name: "Diagram",
  props: z.object({
    title: requiredText(),
    nodes: listOf(DiagramNode.ref, "DiagramNode[]"),
    edges: listOf(DiagramEdge.ref, "DiagramEdge[]"),
    groups: printedAs(
      z.union([z.array(DiagramGroup.ref), DiagramGroup.ref]),
      "DiagramGroup[]"
    ).optional(),
  }),
  description: "Component diagram of what the PR changes; the app lays it out and draws it",
  component: ({ props }) => (
    <FlowDiagramBlock
      raw={{
        title: props.title,
        nodes: childPropsList(props.nodes).map(withPathText),
        edges: childPropsList(props.edges),
        groups: childPropsList(props.groups).map(withMemberIds),
      }}
    />
  ),
})

export const SequenceParticipant = defineComponent({
  name: "SequenceParticipant",
  props: z.object({ id: requiredText(), label: requiredText(), change: changeSchema() }),
  description: "A column: a service, module or actor",
  component: () => null,
})

export const SequenceMessage = defineComponent({
  name: "SequenceMessage",
  props: z.object({
    from: requiredText(),
    to: requiredText(),
    label: requiredText(),
    change: changeSchema(),
    reply: printedAs(scalar(), "boolean").optional(),
  }),
  description: "One step, in order; reply true draws a dotted return",
  component: () => null,
})

export const SequenceDiagram = defineComponent({
  name: "SequenceDiagram",
  props: z.object({
    title: requiredText(),
    participants: listOf(SequenceParticipant.ref, "SequenceParticipant[]"),
    messages: listOf(SequenceMessage.ref, "SequenceMessage[]"),
  }),
  description: "A request or job moving through steps over time",
  component: ({ props }) => (
    <SequenceDiagramBlock
      raw={{
        title: props.title,
        participants: childPropsList(props.participants),
        messages: childPropsList(props.messages),
      }}
    />
  ),
})

// A child component as the renderer hands it over: { type: "element", props: { … } }.
// A single child (not in a list) counts as a list of one.
function childPropsList(children: unknown): unknown[] {
  const list = Array.isArray(children) ? children : children ? [children] : []

  return list.map(elementProps)
}

function elementProps(child: unknown): unknown {
  return typeof child === "object" && child !== null
    ? (child as { props?: unknown }).props
    : undefined
}

// A node's path written as FileRef("src/a.ts", 42) arrives as that element: keep its path and line.
function withPathText(node: unknown): unknown {
  if (typeof node !== "object" || node === null) return node

  const record = node as Record<string, unknown>
  const pathProps = elementProps(record["path"])
  if (typeof pathProps !== "object" || pathProps === null) return node

  const { path, line } = pathProps as { path?: unknown; line?: unknown }
  return { ...record, path, line }
}

// A group member written as the node statement itself becomes that node's id.
function withMemberIds(group: unknown): unknown {
  if (typeof group !== "object" || group === null) return group

  const record = group as Record<string, unknown>
  const members = record["nodeIds"]
  const memberList = Array.isArray(members) ? members : members ? [members] : []
  const nodeIds = memberList.map((member) => {
    const props = elementProps(member)
    return typeof props === "object" && props !== null ? (props as { id?: unknown }).id : member
  })
  return { ...record, nodeIds }
}

// PR files open through the block host, with the same path normalization as FileRef.
function useFileOpening(): {
  canOpenFile: (path: string) => boolean
  onOpenFile: (path: string, line: number | null) => void
} {
  const host = useContext(BlockHostContext)
  const canOpenFile = useCallback(
    (path: string) => host.canOpenFile(normalizeFileRefPath(path)),
    [host]
  )
  const onOpenFile = useCallback(
    (path: string, line: number | null) =>
      host.openFile(normalizeFileRefPath(path), line ?? undefined),
    [host]
  )
  return { canOpenFile, onOpenFile }
}

// The renderer hands new prop objects on every parse. Keeping the same object while its content is
// equal means the diagram (and its layout) only changes when what the agent wrote changes.
function useSameWhileEqual<T>(value: T): T {
  const latestRef = useRef<{ key: string; value: T } | null>(null)
  const key = JSON.stringify(value)
  if (latestRef.current?.key !== key) latestRef.current = { key, value }

  return latestRef.current.value
}

function FlowDiagramBlock({ raw }: { raw: RawFlowDiagram }): ReactNode {
  const streaming = useIsStreaming()
  const { canOpenFile, onOpenFile } = useFileOpening()
  const stableRaw = useSameWhileEqual(raw)
  const diagram = useMemo(() => normalizeFlowDiagram(stableRaw), [stableRaw])

  return (
    <DiagramView
      diagram={diagram}
      streaming={streaming}
      canOpenFile={canOpenFile}
      onOpenFile={onOpenFile}
    />
  )
}

function SequenceDiagramBlock({ raw }: { raw: RawSequenceDiagram }): ReactNode {
  const streaming = useIsStreaming()
  const { canOpenFile, onOpenFile } = useFileOpening()
  const stableRaw = useSameWhileEqual(raw)
  const sequence = useMemo(() => normalizeSequenceDiagram(stableRaw), [stableRaw])

  return (
    <SequenceDiagramView
      sequence={sequence}
      streaming={streaming}
      canOpenFile={canOpenFile}
      onOpenFile={onOpenFile}
    />
  )
}
