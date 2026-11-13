import { type ActionEvent, type ParseResult, Renderer } from "@openuidev/react-lang"
import { ThemeProvider } from "@openuidev/react-ui"
// OpenUI's component styles. Only `.text-content*` is unprefixed, and the app doesn't use it.
import "@openuidev/react-ui/styles/index.css"
import { type ReactNode, useCallback, useId, useMemo, useRef, useState } from "react"

import { openExternalUrl } from "@/utils/externalLink/openExternal"
import { stripBidiControls } from "@/utils/text/bidiControls"

import { hasRootStatement, synthesizedRoot } from "@/entity/openuiBlock/blockProgram"

import { ContainedRoot } from "./ContainedRoot"
import styles from "./OpenUiBlock.module.css"
import { createArmedLinkOpener, routeBlockAction, toHttpsUrl } from "./blockActions"
import { type BlockHost, BlockHostContext } from "./blockHost"
import { readStatements } from "./blockStatements"
import { APP_TOKEN_THEME } from "./openUiTheme"
import { REVIEW_ROOT_COMPONENT, canDrawOnItsOwn, reviewLibrary } from "./reviewLibrary"
import { useAppThemeMode } from "./useAppThemeMode"
import { useHasVisibleContent } from "./useHasVisibleContent"

// The only entry point to OpenUI for the rest of the app (contract §2). Loaded with React.lazy,
// so nothing from OpenUI lands in the eager chunk.
//
// Security: no toolProvider or queryLoader is passed, so Query()/Mutation() cannot fetch,
// and the library (reviewLibrary.ts) has no component that loads a URL.

export type OpenUiBlockProps = {
  // The body of one ```openui-lang fence, without the fence lines.
  code: string
  // True while the fence is still open in a streaming reply.
  streaming: boolean
  // Whether a FileRef to this path can be opened (the path is a file of the PR). When false, the
  // FileRef renders as plain text, not a button. Both this check and onOpenFile receive the path
  // after normalizeFileRefPath (blockActions.ts): trimmed, "\\" → "/", leading "./" removed.
  canOpenFile: (path: string) => boolean
  // A FileRef the host said it can open was clicked. `path` is normalized as above.
  onOpenFile: (path: string, line: number | undefined) => void
  // A follow-up button in the block was clicked. The host puts the text in the composer or sends it.
  onFollowUp: (text: string) => void
}

export default function OpenUiBlock(props: OpenUiBlockProps): ReactNode {
  // No block, however broken, may take down the chat: see ContainedRoot for the failure it stops.
  return (
    <ContainedRoot
      className={styles.host}
      fallback={<BlockFallback code={props.code} reason="failed" />}
    >
      <RenderedBlock {...props} />
    </ContainedRoot>
  )
}

// What the last parse of the block found. "unknown" until the first parse.
type BlockState = { kind: "unknown" } | { kind: "parsed"; hasRoot: boolean; droppedParts: string[] }

// Why a closed block shows its fallback instead of what it drew.
//   no-root: no root statement, and nothing to build one from.
//   root-failed: a root statement, but its root could not be built (e.g. a misspelled Stak).
//   nothing-drawn: a root, but nothing in the block shows.
//   failed: rendering threw.
type FallbackReason = "empty" | "no-root" | "root-failed" | "nothing-drawn" | "failed"

function RenderedBlock({
  code,
  streaming,
  canOpenFile,
  onOpenFile,
  onFollowUp,
}: OpenUiBlockProps): ReactNode {
  const mode = useAppThemeMode()
  const [blockState, setBlockState] = useState<BlockState>({ kind: "unknown" })
  const drawingRef = useRef<HTMLDivElement>(null)
  const hasVisibleContent = useHasVisibleContent(drawingRef)

  // A Button or ListItem arms the one URL it shows, and an open_url event opens only that URL.
  const [armedLinks] = useState(createArmedLinkOpener)

  const host = useMemo<BlockHost>(
    () => ({
      canOpenFile,
      openFile: onOpenFile,
      openShownLink: openHttpsUrl,
      armActionLink: armedLinks.arm,
    }),
    [canOpenFile, onOpenFile, armedLinks]
  )

  // A model sometimes splits one program across two fences, and the second has no root. Once the
  // fence is closed, such a block gets a root over its top-level components, so it still draws
  // where the agent put it. While streaming, no root just means "not yet".
  const statements = useMemo(() => (streaming ? [] : readStatements(code)), [code, streaming])
  const program = useMemo(() => {
    const root = synthesizedRoot(statements, REVIEW_ROOT_COMPONENT, canDrawOnItsOwn)
    return root ? `${code}\n${root}` : code
  }, [code, statements])

  const handleAction = useCallback(
    (event: ActionEvent) => {
      const route = routeBlockAction(event)
      if (route.kind === "follow-up") onFollowUp(route.text)
      if (route.kind === "open-url" && armedLinks.takeArmed(route.url)) openHttpsUrl(route.url)
    },
    [onFollowUp, armedLinks]
  )

  const handleParseResult = useCallback((result: ParseResult | null) => {
    setBlockState({
      kind: "parsed",
      hasRoot: result?.root != null,
      droppedParts: describeDroppedParts(result?.meta.errors ?? [], result?.meta.unresolved ?? []),
    })
  }, [])

  const fallbackReason = streaming
    ? null
    : fallbackReasonFor({
        code,
        blockState,
        hasVisibleContent,
        hasRootStatement: hasRootStatement(statements),
      })
  const droppedParts = blockState.kind === "parsed" ? blockState.droppedParts : []

  return (
    <div className={styles.block}>
      <ThemeProvider
        mode={mode}
        cssSelector={`.${styles.block}`}
        lightTheme={APP_TOKEN_THEME}
        darkTheme={APP_TOKEN_THEME}
      >
        <BlockHostContext.Provider value={host}>
          <div ref={drawingRef}>
            <Renderer
              response={program}
              library={reviewLibrary}
              isStreaming={streaming}
              onAction={handleAction}
              onParseResult={handleParseResult}
            />
          </div>
        </BlockHostContext.Provider>
      </ThemeProvider>
      {fallbackReason && <BlockFallback code={code} reason={fallbackReason} />}
      {!streaming && droppedParts.length > 0 && (
        <p className={styles.droppedNote} role="note">
          {`Part of this block could not be shown: ${droppedParts.join(", ")}.`}
        </p>
      )}
    </div>
  )
}

type FallbackInputs = {
  code: string
  blockState: BlockState
  hasVisibleContent: boolean | null
  hasRootStatement: boolean
}

function fallbackReasonFor({
  code,
  blockState,
  hasVisibleContent,
  hasRootStatement,
}: FallbackInputs): FallbackReason | null {
  if (code.trim() === "") return "empty"
  if (blockState.kind === "unknown") return null
  if (!blockState.hasRoot) return hasRootStatement ? "root-failed" : "no-root"
  // Judged on what actually shows, not on the parse tree: text in a Stack or a Callout root draws,
  // a root of parts that render nothing does not.
  if (hasVisibleContent === false) return "nothing-drawn"

  return null
}

// OpenUI drops a component it cannot build and renders the rest silently, so a misspelled
// Diagramm vanished. These are the error codes that drop one (lang-core 1.1.0); any other error
// was recovered from. Names come from the agent, so they are shown as plain text.
const DROPPING_ERRORS = new Set(["unknown-component", "missing-required", "null-required"])
const MAX_NAMED_PARTS = 3

type ValidationError = ParseResult["meta"]["errors"][number]

function describeDroppedParts(errors: ValidationError[], unresolved: string[]): string[] {
  const undefinedNames = unresolved.map(
    (name) => `${stripBidiControls(name)} is not defined in this block`
  )
  const parts = errors
    .filter((error) => DROPPING_ERRORS.has(error.code))
    .map((error) => {
      const component = stripBidiControls(error.component)
      return error.code === "unknown-component"
        ? `${component} is not a known component`
        : `${component} is missing ${stripBidiControls(error.path.replace(/^\//, ""))}`
    })
  const uniqueParts = [...new Set([...undefinedNames, ...parts])]
  if (uniqueParts.length <= MAX_NAMED_PARTS) return uniqueParts

  const hiddenCount = uniqueParts.length - MAX_NAMED_PARTS
  return [...uniqueParts.slice(0, MAX_NAMED_PARTS), `and ${hiddenCount} more`]
}

// Model-chosen URLs leave the app only as https, through the app's one external-URL util.
function openHttpsUrl(raw: string): void {
  const url = toHttpsUrl(raw)
  if (!url) return

  openExternalUrl(url).catch((error: unknown) => console.error("Could not open link:", error))
}

type BlockFallbackProps = {
  code: string
  reason: FallbackReason
}

const FALLBACK_NOTES: Record<Exclude<FallbackReason, "empty">, string> = {
  "no-root": "This block has no root statement and nothing to build one from. Its source:",
  "root-failed": "This block's root could not be built. Its source:",
  "nothing-drawn": "Nothing in this block could be drawn. Its source:",
  failed: "This block could not be shown. Its source:",
}

function BlockFallback({ code, reason }: BlockFallbackProps): ReactNode {
  const noteId = useId()

  if (reason === "empty") {
    return (
      <figure className={styles.fallback} aria-labelledby={noteId}>
        <figcaption id={noteId} className={styles.fallbackNote}>
          This block is empty.
        </figcaption>
      </figure>
    )
  }

  return (
    <figure className={styles.fallback} aria-labelledby={noteId}>
      <figcaption id={noteId} className={styles.fallbackNote}>
        {FALLBACK_NOTES[reason]}
      </figcaption>
      <pre className={styles.fallbackCode}>
        <code>{code}</code>
      </pre>
    </figure>
  )
}
