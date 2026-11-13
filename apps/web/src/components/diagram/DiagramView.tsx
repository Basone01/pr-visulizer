import { type ReactNode, useId, useMemo, useRef } from "react"

import { type LayoutDirection, nextLayoutDirection } from "@/utils/diagram/layoutDirection"

import { flowLayeredGraph, flowNodeBoxes } from "@/entity/diagram/diagramBoxes"
import { flowLedgerEntries, flowRelationshipLines } from "@/entity/diagram/diagramLedger"
import type { FlowDiagram } from "@/entity/diagram/flowDiagram"

import styles from "./Diagram.module.css"
import { FlowDiagramSvg, flowSvgSize } from "./FlowDiagramSvg"
import {
  DiagramLedger,
  DiagramPlaceholder,
  type OpenFile,
  ScalingCanvas,
  scrollsInBlock,
} from "./diagramParts"
import { type FlowLayoutState, type LayoutStateOf, useFlowLayouts } from "./useFlowLayout"
import { useInlineSize } from "./useInlineSize"

// A component diagram of what a PR touches, laid out by elk and drawn by the app.
// Runs top-to-bottom in a narrow block and left-to-right from 720 px, unless the left-to-right
// layout would have to scroll at this width: then the top-to-bottom one is shown. At most these
// two layouts are made, and both are kept. The SVG scales with the block down to 80% of its
// natural size, and scrolls inside the block below that.

export type DiagramViewProps = {
  diagram: FlowDiagram
  // True while the reply that holds this diagram is still streaming: nothing is laid out yet.
  streaming: boolean
  // Whether a node's path is a file this PR can open, and opening it.
  canOpenFile: (path: string) => boolean
  onOpenFile: OpenFile
}

export function DiagramView({
  diagram,
  streaming,
  canOpenFile,
  onOpenFile,
}: DiagramViewProps): ReactNode {
  const figureRef = useRef<HTMLElement>(null)
  const width = useInlineSize(figureRef)
  const direction = useStickyDirection(width)
  const idPrefix = `diagram-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`

  // Nothing is measured or laid out before the block is complete and its width is known: while
  // it streams, every token would build a new diagram.
  const isReadyToLayOut = !streaming && width !== null && diagram.nodes.length > 0
  const boxes = useMemo(
    () => (isReadyToLayOut ? flowNodeBoxes(diagram) : []),
    [isReadyToLayOut, diagram]
  )
  const graph = useMemo(
    () => (isReadyToLayOut ? flowLayeredGraph(diagram, boxes) : null),
    [isReadyToLayOut, diagram, boxes]
  )
  const boxById = useMemo(() => new Map(boxes.map((box) => [box.id, box])), [boxes])
  const ledger = useMemo(() => flowLedgerEntries(diagram), [diagram])

  // Left-to-right that would need scrolling at this width also asks for top-to-bottom.
  const wideWouldScroll = (stateOf: LayoutStateOf): boolean => {
    const wide = stateOf("right")
    return (
      direction === "right" &&
      wide.status === "ready" &&
      scrollsInBlock(flowSvgSize(diagram, wide.layout).width, width ?? 0)
    )
  }
  const layouts = useFlowLayouts(graph, (stateOf) =>
    wideWouldScroll(stateOf) ? [direction, "down"] : [direction]
  )
  const layoutState = pickShownLayout(layouts, direction, wideWouldScroll(layouts))

  // Empty only once the block is complete: while it streams, the Diagram line arrives before its
  // nodes, so "no components yet" is not "no components".
  const isEmpty = !streaming && diagram.nodes.length === 0

  return (
    <figure ref={figureRef} className={styles.diagram}>
      <figcaption className={styles.title}>{diagram.title}</figcaption>
      {isEmpty && <DiagramPlaceholder text="This diagram has no components to draw." isCompact />}
      {!isEmpty && layoutState.status === "waiting" && (
        <DiagramPlaceholder
          text={
            streaming
              ? "Drawing the diagram when the reply is complete…"
              : "Laying out the diagram…"
          }
        />
      )}
      {layoutState.status === "failed" && <RelationshipFallback diagram={diagram} />}
      {layoutState.status === "ready" && (
        <ScalingCanvas
          naturalWidth={flowSvgSize(diagram, layoutState.layout).width}
          blockWidth={width ?? 0}
        >
          <FlowDiagramSvg
            idPrefix={idPrefix}
            diagram={diagram}
            boxes={boxById}
            layout={layoutState.layout}
            canOpenFile={canOpenFile}
            onOpenFile={onOpenFile}
          />
        </ScalingCanvas>
      )}
      {diagram.notices.map((notice) => (
        <p key={notice} className={styles.notice}>
          {notice}
        </p>
      ))}
      <DiagramLedger entries={ledger} canOpenFile={canOpenFile} onOpenFile={onOpenFile} />
    </figure>
  )
}

// The layout to show: top-to-bottom first when left-to-right would scroll, otherwise the
// preferred direction. While that one is still laying out, an already-ready layout in the other
// direction is shown instead of the placeholder.
function pickShownLayout(
  layouts: LayoutStateOf,
  direction: LayoutDirection,
  wideWouldScroll: boolean
): FlowLayoutState {
  const first = wideWouldScroll ? "down" : direction
  const second: LayoutDirection = first === "down" ? "right" : "down"
  const firstState = layouts(first)
  const secondState = layouts(second)

  if (firstState.status === "ready") return firstState
  if (secondState.status === "ready") return secondState

  return firstState
}

// The direction for this width, with hysteresis against the direction chosen last time.
// Nothing is remembered before the first measurement.
function useStickyDirection(width: number | null): LayoutDirection {
  const lastRef = useRef<LayoutDirection | null>(null)
  if (width === null) return "down"

  const direction = nextLayoutDirection(lastRef.current, width)
  lastRef.current = direction
  return direction
}

function RelationshipFallback({ diagram }: { diagram: FlowDiagram }): ReactNode {
  const lines = flowRelationshipLines(diagram)

  return (
    <div>
      <p className={styles.status}>The diagram could not be laid out. Its relationships:</p>
      {lines.length > 0 ? (
        <ul className={styles.relationList}>
          {lines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className={styles.status}>{diagram.nodes.map((node) => node.label).join(", ")}</p>
      )}
    </div>
  )
}
