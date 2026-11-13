import { type ActionEvent, type ParseResult, Renderer } from "@openuidev/react-lang"
import { ThemeProvider } from "@openuidev/react-ui"
// OpenUI's component styles. Only `.text-content*` is unprefixed, and the app doesn't use it.
import "@openuidev/react-ui/styles/index.css"
import { type ReactNode, useCallback, useId, useMemo, useState } from "react"

import { openExternalUrl } from "@/utils/externalLink/openExternal"
import { stripBidiControls } from "@/utils/text/bidiControls"

import { ContainedRoot } from "./ContainedRoot"
import styles from "./OpenUiBlock.module.css"
import { createArmedLinkOpener, routeBlockAction, toHttpsUrl } from "./blockActions"
import { type BlockHost, BlockHostContext } from "./blockHost"
import { APP_TOKEN_THEME } from "./openUiTheme"
import { reviewLibrary } from "./reviewLibrary"
import { useAppThemeMode } from "./useAppThemeMode"

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
    <ContainedRoot className={styles.host} fallback={<BlockFallback code={props.code} />}>
      <RenderedBlock {...props} />
    </ContainedRoot>
  )
}

type RootState = "unknown" | "present" | "absent"

function RenderedBlock({
  code,
  streaming,
  canOpenFile,
  onOpenFile,
  onFollowUp,
}: OpenUiBlockProps): ReactNode {
  const mode = useAppThemeMode()
  const [rootState, setRootState] = useState<RootState>("unknown")
  const [droppedParts, setDroppedParts] = useState<string[]>([])

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

  const handleAction = useCallback(
    (event: ActionEvent) => {
      const route = routeBlockAction(event)
      if (route.kind === "follow-up") onFollowUp(route.text)
      if (route.kind === "open-url" && armedLinks.takeArmed(route.url)) openHttpsUrl(route.url)
    },
    [onFollowUp, armedLinks]
  )

  const handleParseResult = useCallback((result: ParseResult | null) => {
    setRootState(result?.root ? "present" : "absent")
    setDroppedParts(describeDroppedParts(result?.meta.errors ?? []))
  }, [])

  // While streaming, an empty program is just "not yet". Once the fence closed, it's a failure.
  const isUnrenderable = !streaming && rootState === "absent"

  return (
    <div className={styles.block}>
      <ThemeProvider
        mode={mode}
        cssSelector={`.${styles.block}`}
        lightTheme={APP_TOKEN_THEME}
        darkTheme={APP_TOKEN_THEME}
      >
        <BlockHostContext.Provider value={host}>
          <Renderer
            response={code}
            library={reviewLibrary}
            isStreaming={streaming}
            onAction={handleAction}
            onParseResult={handleParseResult}
          />
        </BlockHostContext.Provider>
      </ThemeProvider>
      {isUnrenderable && <BlockFallback code={code} />}
      {!streaming && rootState === "present" && droppedParts.length > 0 && (
        <p className={styles.droppedNote} role="note">
          {`Part of this block could not be shown: ${droppedParts.join(", ")}.`}
        </p>
      )}
    </div>
  )
}

// OpenUI drops a component it cannot build and renders the rest silently, so a misspelled
// Diagramm vanished. These are the error codes that drop one (lang-core 1.1.0); any other error
// was recovered from. Names come from the agent, so they are shown as plain text.
const DROPPING_ERRORS = new Set(["unknown-component", "missing-required", "null-required"])
const MAX_NAMED_PARTS = 3

type ValidationError = ParseResult["meta"]["errors"][number]

function describeDroppedParts(errors: ValidationError[]): string[] {
  const parts = errors
    .filter((error) => DROPPING_ERRORS.has(error.code))
    .map((error) => {
      const component = stripBidiControls(error.component)
      return error.code === "unknown-component"
        ? `${component} is not a known component`
        : `${component} is missing ${stripBidiControls(error.path.replace(/^\//, ""))}`
    })
  const uniqueParts = [...new Set(parts)]
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
}

function BlockFallback({ code }: BlockFallbackProps): ReactNode {
  const noteId = useId()

  return (
    <figure className={styles.fallback} aria-labelledby={noteId}>
      <figcaption id={noteId} className={styles.fallbackNote}>
        This block could not be shown. Its source:
      </figcaption>
      <pre className={styles.fallbackCode}>
        <code>{code}</code>
      </pre>
    </figure>
  )
}
