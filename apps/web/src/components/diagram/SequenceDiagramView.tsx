import { type ReactNode, useId, useMemo, useRef } from "react"

import { roundedOrthogonalPath } from "@/utils/diagram/orthogonalPath"
import {
  SELF_LOOP_HEIGHT,
  SELF_LOOP_WIDTH,
  SEQUENCE_HEADER_HEIGHT,
  type SequenceLayout,
  layoutSequence,
} from "@/utils/diagram/sequenceLayout"

import {
  type ParticipantBox,
  messageLabelText,
  participantBoxes,
  sequenceLayoutInput,
} from "@/entity/diagram/diagramBoxes"
import { sequenceLedgerEntries } from "@/entity/diagram/diagramLedger"
import type { ChangeKind } from "@/entity/diagram/diagramModel"
import type { SequenceDiagram } from "@/entity/diagram/sequenceDiagram"

import styles from "./Diagram.module.css"
import {
  CHANGE_CLASS,
  ChangeBadge,
  DiagramLedger,
  DiagramLegend,
  DiagramPlaceholder,
  type OpenFile,
  ScalingCanvas,
  describeCounts,
  legendHeight,
  presentChanges,
} from "./diagramParts"
import { useInlineSize } from "./useInlineSize"

// A request or job moving through steps over time: participants as columns with lifelines,
// messages as rows in order. The order is the layout, so it is drawn at once, no elk.

export type SequenceDiagramViewProps = {
  sequence: SequenceDiagram
  // True while the reply that holds this sequence is still streaming: nothing is measured yet.
  streaming: boolean
  canOpenFile: (path: string) => boolean
  onOpenFile: OpenFile
}

const HEADER_CORNER_RADIUS = 6
const SELF_LOOP_RADIUS = 6

export function SequenceDiagramView({
  sequence,
  streaming,
  canOpenFile,
  onOpenFile,
}: SequenceDiagramViewProps): ReactNode {
  const figureRef = useRef<HTMLElement>(null)
  const width = useInlineSize(figureRef)
  const idPrefix = `sequence-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`

  // Nothing is measured while the block streams: every token would build a new sequence.
  const isReadyToDraw = !streaming && sequence.participants.length > 0
  const drawing = useMemo(() => {
    if (!isReadyToDraw) return null

    const boxes = participantBoxes(sequence)
    const { columns, rows } = sequenceLayoutInput(sequence, boxes)
    return { boxes, layout: layoutSequence(columns, rows) }
  }, [isReadyToDraw, sequence])
  const ledger = useMemo(() => sequenceLedgerEntries(sequence), [sequence])

  // Empty only once the block is complete: while it streams, participants have not arrived yet.
  const isEmpty = !streaming && sequence.participants.length === 0

  return (
    <figure ref={figureRef} className={styles.diagram}>
      <figcaption className={styles.title}>{sequence.title}</figcaption>
      {isEmpty && (
        <DiagramPlaceholder text="This sequence has no participants to draw." isCompact />
      )}
      {streaming && <DiagramPlaceholder text="Drawing the sequence when the reply is complete…" />}
      {drawing && (
        <ScalingCanvas naturalWidth={drawing.layout.width} blockWidth={width ?? 0}>
          <SequenceSvg
            idPrefix={idPrefix}
            sequence={sequence}
            boxes={drawing.boxes}
            layout={drawing.layout}
          />
        </ScalingCanvas>
      )}
      {sequence.notices.map((notice) => (
        <p key={notice} className={styles.notice}>
          {notice}
        </p>
      ))}
      <DiagramLedger entries={ledger} canOpenFile={canOpenFile} onOpenFile={onOpenFile} />
    </figure>
  )
}

type SequenceSvgProps = {
  idPrefix: string
  sequence: SequenceDiagram
  boxes: ParticipantBox[]
  layout: SequenceLayout
}

function SequenceSvg({ idPrefix, sequence, boxes, layout }: SequenceSvgProps): ReactNode {
  const changes: ChangeKind[] = [
    ...sequence.participants.map((participant) => participant.change),
    ...sequence.messages.map((message) => message.change),
  ]
  const shownChanges = presentChanges(changes)
  const height = layout.height + legendHeight(shownChanges, layout.width)
  const titleId = `${idPrefix}-title`
  const descId = `${idPrefix}-desc`
  const markerId = (change: ChangeKind) => `${idPrefix}-arrow-${change}`
  const description = describeCounts(
    [
      [sequence.participants.length, "participant", "participants"],
      [sequence.messages.length, "message", "messages"],
    ],
    changes
  )
  // Every name in full, so a name cut short in the picture is still readable without a mouse.
  const names = `Participants: ${sequence.participants.map((participant) => participant.label).join(", ")}.`

  return (
    <svg
      className={styles.svg}
      viewBox={`0 0 ${layout.width} ${height}`}
      role="img"
      aria-labelledby={`${titleId} ${descId}`}
      style={{ maxWidth: layout.width, minWidth: Math.round(layout.width * 0.8) }}
    >
      <title id={titleId}>{sequence.title}</title>
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
      <rect className={styles.surface} x={0} y={0} width={layout.width} height={height} />

      {layout.columns.map((column, index) => (
        <line
          key={`lifeline-${index}`}
          className={styles.lifeline}
          x1={column.center}
          x2={column.center}
          y1={layout.lifelineTop}
          y2={layout.lifelineBottom}
        />
      ))}

      {sequence.messages.map((message, index) => {
        const row = layout.rows[index]
        if (!row) return null

        const points = row.isSelf
          ? [
              { x: row.fromX, y: row.y },
              { x: row.fromX + SELF_LOOP_WIDTH, y: row.y },
              { x: row.fromX + SELF_LOOP_WIDTH, y: row.y + SELF_LOOP_HEIGHT },
              { x: row.fromX + 4, y: row.y + SELF_LOOP_HEIGHT },
            ]
          : [
              { x: row.fromX, y: row.y },
              { x: row.toX + (row.toX > row.fromX ? -1 : 1), y: row.y },
            ]
        const statusClass = CHANGE_CLASS[message.change] ?? ""
        const drawnLabel = messageLabelText(message.label)

        return (
          <g key={message.id}>
            {drawnLabel !== message.label && <title>{message.label}</title>}
            <path
              className={`${styles.edge} ${statusClass} ${message.reply ? styles.reply : ""}`}
              d={roundedOrthogonalPath(points, SELF_LOOP_RADIUS)}
              markerEnd={`url(#${markerId(message.change)})`}
            />
            <text
              className={`${styles.messageLabel} ${statusClass}`}
              x={row.label.x}
              y={row.label.y}
              textAnchor={row.label.anchor}
              dominantBaseline={row.isSelf ? "central" : "auto"}
            >
              {drawnLabel}
            </text>
          </g>
        )
      })}

      {sequence.participants.map((participant, index) => {
        const column = layout.columns[index]
        const box = boxes[index]
        if (!column || !box) return null

        const header = column.header
        return (
          <g key={participant.id} className={CHANGE_CLASS[participant.change]}>
            <title>{participant.label}</title>
            <rect
              className={styles.nodeBox}
              x={header.x}
              y={header.y}
              width={header.width}
              height={SEQUENCE_HEADER_HEIGHT}
              rx={HEADER_CORNER_RADIUS}
            />
            <text
              className={styles.nodeName}
              x={column.center}
              y={header.y + SEQUENCE_HEADER_HEIGHT / 2}
              textAnchor="middle"
              dominantBaseline="central"
            >
              {box.label}
            </text>
          </g>
        )
      })}

      {sequence.participants.map((participant, index) => {
        const header = layout.columns[index]?.header
        if (!header || participant.change === "unchanged") return null

        return (
          <ChangeBadge
            key={participant.id}
            change={participant.change}
            x={header.x + header.width}
            y={header.y}
          />
        )
      })}
      {sequence.messages.map((message, index) => {
        const row = layout.rows[index]
        if (!row || message.change === "unchanged") return null

        const x = row.isSelf ? row.fromX + SELF_LOOP_WIDTH : Math.min(row.fromX, row.toX) + 12
        return <ChangeBadge key={message.id} change={message.change} x={x} y={row.y} />
      })}

      <DiagramLegend changes={shownChanges} top={layout.height} width={layout.width} />
    </svg>
  )
}
