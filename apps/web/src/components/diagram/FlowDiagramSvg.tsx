import type { KeyboardEvent, ReactNode } from "react"

import type { LayeredLayout, Rect } from "@/utils/diagram/layeredLayout"
import { longestSegmentMidpoint, roundedOrthogonalPath } from "@/utils/diagram/orthogonalPath"
import { estimateTextWidth, wrapText } from "@/utils/diagram/textMetrics"

import {
  EDGE_BADGE_ROW,
  EDGE_LABEL_LINE_HEIGHT,
  type FlowNodeBox,
  NAME_FONT_SIZE,
  NAME_LINE_HEIGHT,
  NODE_PADDING_X,
  SUBLABEL_FONT_SIZE,
  TAG_FONT_SIZE,
  TAG_ROW_HEIGHT,
  edgeLabelBox,
  edgeLabelText,
} from "@/entity/diagram/diagramBoxes"
import type { ChangeKind } from "@/entity/diagram/diagramModel"
import type { FlowDiagram, FlowEdge, FlowGroup, FlowNode } from "@/entity/diagram/flowDiagram"

import styles from "./Diagram.module.css"
import {
  BADGE_RADIUS,
  CHANGE_CLASS,
  ChangeBadge,
  DiagramLegend,
  type OpenFile,
  describeCounts,
  legendHeight,
  presentChanges,
} from "./diagramParts"

// Draws a laid-out flow diagram. Everything the agent wrote reaches the SVG only as React text
// children, never as markup, attributes that load anything, or links.

const EDGE_CORNER_RADIUS = 8
const GROUP_CORNER_RADIUS = 8
const NODE_CORNER_RADIUS = 6
const EXTERNAL_INSET = 3
const STORE_RIM_OFFSET = 6
const FOCUS_RING_GAP = 3
const EYEBROW_FONT_SIZE = 9
// Matches `.eyebrow` letter-spacing in Diagram.module.css.
const EYEBROW_LETTER_SPACING_EM = 0.14
const EYEBROW_MASK_PADDING = 3

type FlowDiagramSvgProps = {
  idPrefix: string
  diagram: FlowDiagram
  boxes: Map<string, FlowNodeBox>
  layout: LayeredLayout
  canOpenFile: (path: string) => boolean
  onOpenFile: OpenFile
}

export function flowSvgSize(
  diagram: FlowDiagram,
  layout: LayeredLayout
): { width: number; height: number } {
  const changes = presentChanges(allChanges(diagram))
  return { width: layout.width, height: layout.height + legendHeight(changes, layout.width) }
}

function allChanges(diagram: FlowDiagram): ChangeKind[] {
  return [...diagram.nodes.map((node) => node.change), ...diagram.edges.map((edge) => edge.change)]
}

export function FlowDiagramSvg({
  idPrefix,
  diagram,
  boxes,
  layout,
  canOpenFile,
  onOpenFile,
}: FlowDiagramSvgProps): ReactNode {
  const { width, height } = flowSvgSize(diagram, layout)
  const titleId = `${idPrefix}-title`
  const descId = `${idPrefix}-desc`
  const markerId = (change: ChangeKind) => `${idPrefix}-arrow-${change}`
  const description = describeCounts(
    [
      [diagram.nodes.length, "component", "components"],
      [diagram.edges.length, "relationship", "relationships"],
    ],
    allChanges(diagram)
  )
  // Every name in full, so a name cut short in the picture is still readable without a mouse.
  const names = `Components: ${diagram.nodes.map((node) => node.label).join(", ")}.`
  // An image's children are presentational (WAI-ARIA), so a picture holding buttons is a group.
  const hasOpenableNode = diagram.nodes.some((node) => node.path !== null && canOpenFile(node.path))

  return (
    <svg
      className={styles.svg}
      viewBox={`0 0 ${width} ${height}`}
      role={hasOpenableNode ? "group" : "img"}
      aria-labelledby={`${titleId} ${descId}`}
      style={{ maxWidth: width, minWidth: Math.round(width * 0.8) }}
    >
      <title id={titleId}>{diagram.title}</title>
      <desc id={descId}>{`${description} ${names}`}</desc>
      <defs>
        {(["unchanged", "added", "changed", "removed"] as const).map((change) => (
          <marker
            key={change}
            id={markerId(change)}
            className={CHANGE_CLASS[change]}
            markerWidth={8}
            markerHeight={6}
            refX={7}
            refY={3}
            orient="auto"
          >
            <polygon className={styles.arrowHead} points="0 0, 8 3, 0 6" />
          </marker>
        ))}
      </defs>
      <rect className={styles.surface} x={0} y={0} width={width} height={height} />

      {diagram.groups.map((group) => (
        <GroupZone key={group.id} group={group} rect={layout.containers.get(group.id)} />
      ))}
      {diagram.edges.map((edge) => (
        <EdgePath key={edge.id} edge={edge} layout={layout} markerId={markerId(edge.change)} />
      ))}
      {diagram.groups.map((group) => (
        <GroupEyebrow key={group.id} group={group} rect={layout.containers.get(group.id)} />
      ))}
      {diagram.edges.map((edge) => (
        <EdgeLabel key={edge.id} edge={edge} rect={layout.edges.get(edge.id)?.label ?? null} />
      ))}
      {diagram.nodes.map((node) => {
        const box = boxes.get(node.id)
        const rect = layout.boxes.get(node.id)
        if (!box || !rect) return null

        const path = node.path
        const onOpen = path !== null && canOpenFile(path) ? () => onOpenFile(path, node.line) : null
        return <NodeShape key={node.id} node={node} box={box} rect={rect} onOpen={onOpen} />
      })}
      {diagram.nodes.map((node) => {
        const rect = layout.boxes.get(node.id)
        if (!rect || node.change === "unchanged") return null

        return <ChangeBadge key={node.id} change={node.change} x={rect.x + rect.width} y={rect.y} />
      })}
      {diagram.edges.map((edge) => (
        <EdgeBadge key={edge.id} edge={edge} layout={layout} />
      ))}

      <DiagramLegend
        changes={presentChanges(allChanges(diagram))}
        top={layout.height}
        width={width}
      />
    </svg>
  )
}

function GroupZone({ group, rect }: { group: FlowGroup; rect: Rect | undefined }): ReactNode {
  if (!rect) return null

  return (
    <rect
      className={styles.groupZone}
      x={rect.x}
      y={rect.y}
      width={rect.width}
      height={rect.height}
      rx={GROUP_CORNER_RADIUS}
    />
  )
}

// Drawn after the edges, on a chip in the group's own fill: elk may route an edge into a group
// through its header, and the line must pass under the name, not through it.
function GroupEyebrow({ group, rect }: { group: FlowGroup; rect: Rect | undefined }): ReactNode {
  if (!rect) return null

  // Fitted, masked and drawn with the same letter spacing, so the name and its chip stay inside
  // the group's padding.
  const eyebrow =
    wrapText(
      group.label.toUpperCase(),
      rect.width - NODE_PADDING_X * 2,
      EYEBROW_FONT_SIZE,
      "mono",
      1,
      EYEBROW_LETTER_SPACING_EM
    ).lines[0] ?? ""
  const textWidth = estimateTextWidth(eyebrow, EYEBROW_FONT_SIZE, "mono", EYEBROW_LETTER_SPACING_EM)
  const textX = rect.x + NODE_PADDING_X
  return (
    <g>
      <rect
        className={styles.eyebrowMask}
        x={textX - EYEBROW_MASK_PADDING}
        y={rect.y + 8}
        width={textWidth + EYEBROW_MASK_PADDING * 2}
        height={14}
        rx={2}
      />
      <text className={styles.eyebrow} x={textX} y={rect.y + 18}>
        {eyebrow}
      </text>
    </g>
  )
}

function EdgePath({
  edge,
  layout,
  markerId,
}: {
  edge: FlowEdge
  layout: LayeredLayout
  markerId: string
}): ReactNode {
  const points = layout.edges.get(edge.id)?.points ?? []
  if (points.length < 2) return null

  return (
    <path
      className={`${styles.edge} ${CHANGE_CLASS[edge.change] ?? ""}`}
      d={roundedOrthogonalPath(points, EDGE_CORNER_RADIUS)}
      markerEnd={`url(#${markerId})`}
    />
  )
}

function EdgeLabel({ edge, rect }: { edge: FlowEdge; rect: Rect | null }): ReactNode {
  if (!edge.label || !rect) return null

  const { lines } = edgeLabelBox(edge.label, edge.change)
  const isCut = edgeLabelText(edge.label) !== edge.label.toUpperCase()
  const badgeRow = edge.change === "unchanged" ? 0 : EDGE_BADGE_ROW
  const centerX = rect.x + rect.width / 2
  // Lines are centred as a block on the space below the badge row.
  const textMiddle = rect.y + badgeRow + (rect.height - badgeRow) / 2
  const firstLineY = textMiddle - ((lines.length - 1) * EDGE_LABEL_LINE_HEIGHT) / 2
  return (
    <g>
      <rect
        className={styles.labelMask}
        x={rect.x}
        y={rect.y}
        width={rect.width}
        height={rect.height}
        rx={2}
      />
      {isCut && <title>{edge.label}</title>}
      <text className={styles.edgeLabel} textAnchor="middle" dominantBaseline="central">
        {lines.map((line, index) => (
          <tspan key={index} x={centerX} y={firstLineY + index * EDGE_LABEL_LINE_HEIGHT}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  )
}

// On a labelled edge the badge sits in the row above the label's text; otherwise it sits mid-edge.
function EdgeBadge({ edge, layout }: { edge: FlowEdge; layout: LayeredLayout }): ReactNode {
  if (edge.change === "unchanged") return null

  const placed = layout.edges.get(edge.id)
  const label = edge.label ? placed?.label : null
  const anchor = label
    ? { x: label.x + label.width / 2, y: label.y + BADGE_RADIUS + 1 }
    : longestSegmentMidpoint(placed?.points ?? [])
  if (!anchor) return null

  return <ChangeBadge change={edge.change} x={anchor.x} y={anchor.y} />
}

type NodeShapeProps = {
  node: FlowNode
  box: FlowNodeBox
  rect: Rect
  onOpen: (() => void) | null
}

function NodeShape({ node, box, rect, onOpen }: NodeShapeProps): ReactNode {
  const centerX = rect.x + rect.width / 2
  const nameTop = rect.y + box.nameTop
  const fullText = node.path ? `${node.label} — ${node.path}` : node.label
  const interaction = onOpen
    ? {
        role: "button",
        tabIndex: 0,
        "aria-label": `${node.label}, open ${node.path}`,
        onClick: onOpen,
        onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
          if (event.key !== "Enter" && event.key !== " ") return

          event.preventDefault()
          onOpen()
        },
      }
    : {}

  return (
    <g
      className={`${CHANGE_CLASS[node.change] ?? ""} ${onOpen ? styles.openable : ""}`}
      {...interaction}
    >
      <title>{fullText}</title>
      {onOpen && (
        <rect
          className={styles.focusRing}
          x={rect.x - FOCUS_RING_GAP}
          y={rect.y - FOCUS_RING_GAP}
          width={rect.width + FOCUS_RING_GAP * 2}
          height={rect.height + FOCUS_RING_GAP * 2}
          rx={NODE_CORNER_RADIUS + FOCUS_RING_GAP}
        />
      )}
      <rect
        className={styles.nodeBox}
        x={rect.x}
        y={rect.y}
        width={rect.width}
        height={rect.height}
        rx={node.kind === "external" ? 2 : NODE_CORNER_RADIUS}
      />
      <KindDetail kind={node.kind} rect={rect} />
      {box.tag && (
        <text
          className={styles.nodeTag}
          x={centerX}
          y={nameTop - TAG_ROW_HEIGHT + TAG_FONT_SIZE}
          textAnchor="middle"
        >
          {box.tag}
        </text>
      )}
      <text className={styles.nodeName} x={centerX} textAnchor="middle">
        {box.nameLines.map((line, index) => (
          <tspan key={index} x={centerX} y={nameTop + NAME_FONT_SIZE + index * NAME_LINE_HEIGHT}>
            {line}
          </tspan>
        ))}
      </text>
      {box.sublabel && (
        <text
          className={styles.nodeSublabel}
          x={centerX}
          y={nameTop + box.nameLines.length * NAME_LINE_HEIGHT + SUBLABEL_FONT_SIZE + 2}
          textAnchor="middle"
        >
          {box.sublabel}
        </text>
      )}
    </g>
  )
}

// Kinds are recognisable without colour: a store has a rim line under its top edge (a cylinder's
// lid), an external system a double border with square corners.
function KindDetail({ kind, rect }: { kind: FlowNode["kind"]; rect: Rect }): ReactNode {
  if (kind === "store") {
    return (
      <line
        className={styles.nodeDetail}
        x1={rect.x}
        x2={rect.x + rect.width}
        y1={rect.y + STORE_RIM_OFFSET}
        y2={rect.y + STORE_RIM_OFFSET}
      />
    )
  }
  if (kind === "external") {
    return (
      <rect
        className={styles.nodeDetail}
        x={rect.x + EXTERNAL_INSET}
        y={rect.y + EXTERNAL_INSET}
        width={rect.width - EXTERNAL_INSET * 2}
        height={rect.height - EXTERNAL_INSET * 2}
        rx={1}
      />
    )
  }

  return null
}
