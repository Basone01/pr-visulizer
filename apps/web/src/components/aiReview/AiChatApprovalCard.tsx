import { Fragment, memo, useCallback, useId, useLayoutEffect, useRef, useState } from "react"

import { errorText } from "@/utils/errors/errorText"

import {
  type DisplayedText,
  type ToolApproval,
  type ToolApprovalDecision,
  approvalOutcomeText,
  describeApprovalInput,
  foldBlankLines,
} from "@/entity/aiChat/toolApproval"

import styles from "./AiChatSurface.module.css"

type AiChatApprovalCardProps = {
  approval: ToolApproval
  agentLabel: string
  onAnswer: (requestId: string, decision: ToolApprovalDecision) => Promise<void>
}

const HIDDEN_CHARACTERS_WARNING =
  "This text holds hidden characters, shown as \\u{…} escapes. Check them before you allow it."

// The card never takes focus and has no default action: Allow once is only ever a deliberate
// click or keypress on that button. Its state comes from the app's events, never from a click.
export const AiChatApprovalCard = memo(function AiChatApprovalCard({
  approval,
  agentLabel,
  onAnswer,
}: AiChatApprovalCardProps) {
  const [isAnswering, setIsAnswering] = useState(false)
  const [answerError, setAnswerError] = useState<string | null>(null)
  const isPending = approval.state === "pending"
  const view = describeApprovalInput(approval)
  const outcome = approvalOutcomeText(approval)
  const shownText = view.kind === "command" ? view.command : view.kind === "input" ? view.json : ""
  const displayed = foldBlankLines(shownText)
  const inputBox = useReadToEnd()
  const scrollHintId = useId()
  const lineCountText = describeLineCount(displayed.lineCount, view.kind === "command")
  const mustScrollToAllow = isPending && inputBox.overflows && !inputBox.hasReadToEnd

  async function answer(decision: ToolApprovalDecision): Promise<void> {
    setIsAnswering(true)
    setAnswerError(null)
    try {
      await onAnswer(approval.requestId, decision)
    } catch (error) {
      setAnswerError(errorText(error))
    } finally {
      setIsAnswering(false)
    }
  }

  return (
    <li className={styles.approval} data-state={approval.state}>
      <p className={styles.approvalTitle}>
        {isPending ? `${agentLabel} asks to run ` : `${agentLabel} asked to run `}
        <span className={styles.approvalTool}>{approval.toolName}</span>
      </p>
      {view.kind === "too_large" ? (
        <p className={styles.approvalNote}>
          The input was too large to show, so the app denied it.
        </p>
      ) : (
        <pre
          ref={inputBox.ref}
          className={styles.approvalInput}
          // Scrollable, so it is reachable from the keyboard. It is never focused for the reviewer.
          tabIndex={0}
          aria-label={view.kind === "command" ? "Command" : "Tool input"}
          onScroll={inputBox.check}
        >
          <DisplayedTextParts displayed={displayed} />
          {view.kind === "command" && view.otherOptions !== null && (
            <>
              {"\n\n"}
              <span className={styles.approvalInputLabel}>Other options:</span>
              {"\n"}
              {view.otherOptions}
            </>
          )}
        </pre>
      )}
      {view.kind !== "too_large" && inputBox.overflows && (
        <p id={scrollHintId} className={styles.approvalScrollHint}>
          {mustScrollToAllow
            ? `${lineCountText}, more than fits. Scroll to the end to read it all, Allow once unlocks there.`
            : `${lineCountText}, more than fits. Scroll to read it all.`}
        </p>
      )}
      {view.kind !== "too_large" && !inputBox.overflows && displayed.lineCount > 1 && (
        <p className={styles.approvalNote}>{lineCountText}.</p>
      )}
      {view.kind !== "too_large" && view.hasHiddenCharacters && (
        <p className={styles.approvalWarning}>{HIDDEN_CHARACTERS_WARNING}</p>
      )}
      {view.kind === "command" && view.agentNote !== null && (
        <p className={styles.approvalNote}>
          <span className={styles.approvalNoteLabel}>Agent&apos;s note:</span> {view.agentNote}
        </p>
      )}
      {isPending ? (
        <div className={styles.approvalActions}>
          <button
            type="button"
            className={styles.action}
            disabled={isAnswering || mustScrollToAllow}
            aria-describedby={mustScrollToAllow ? scrollHintId : undefined}
            onClick={() => void answer("allow")}
          >
            Allow once
          </button>
          <button
            type="button"
            className={styles.action}
            disabled={isAnswering}
            onClick={() => void answer("deny")}
          >
            Deny
          </button>
        </div>
      ) : (
        <p className={styles.approvalOutcome}>{outcome}</p>
      )}
      {answerError !== null && (
        <p className={styles.approvalError} role="alert">
          Couldn&apos;t send your answer: {answerError}
        </p>
      )}
    </li>
  )
})

// The marker lines are the app's own text, so they are drawn apart from the command and cannot
// be selected with it.
function DisplayedTextParts({ displayed }: { displayed: DisplayedText }) {
  return displayed.parts.map((part, index) => (
    <Fragment key={index}>
      {index > 0 && "\n"}
      {part.kind === "text" ? (
        part.text
      ) : (
        <span className={styles.approvalInputLabel}>[{part.count} blank lines]</span>
      )}
    </Fragment>
  ))
}

function describeLineCount(lineCount: number, isCommand: boolean): string {
  const lines = lineCount === 1 ? "1 line" : `${lineCount} lines`
  return isCommand ? `The command has ${lines}` : `The input has ${lines}`
}

// Within a pixel counts as the end: scroll positions can be fractional on zoomed or HiDPI screens.
const SCROLL_END_TOLERANCE_PX = 1

// Whether a scroll box holds more than it shows, and whether it has been scrolled to its end
// once. Re-checked on scroll and on resize, because the AI pane is resized often.
function useReadToEnd() {
  const elementRef = useRef<HTMLPreElement | null>(null)
  const [overflows, setOverflows] = useState(false)
  const [hasReadToEnd, setHasReadToEnd] = useState(false)

  const check = useCallback(() => {
    const element = elementRef.current
    if (element === null) return

    const hiddenHeight = element.scrollHeight - element.clientHeight
    const isOverflowing = hiddenHeight > SCROLL_END_TOLERANCE_PX
    const isAtEnd = element.scrollTop >= hiddenHeight - SCROLL_END_TOLERANCE_PX
    setOverflows(isOverflowing)
    // Only an overflowing box scrolled to its end counts as read, so a box that fit and then
    // overflows after a resize is locked again. Once read, a later resize keeps it read.
    if (isOverflowing && isAtEnd) setHasReadToEnd(true)
  }, [])

  // Measured before paint, so Allow is never briefly enabled for a box that overflows.
  useLayoutEffect(() => {
    check()
    const element = elementRef.current
    if (element === null || typeof ResizeObserver === "undefined") return

    const observer = new ResizeObserver(check)
    observer.observe(element)
    return () => observer.disconnect()
  }, [check])

  return { ref: elementRef, overflows, hasReadToEnd, check }
}
