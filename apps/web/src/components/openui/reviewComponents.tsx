import { defineComponent, useIsStreaming, useTriggerAction } from "@openuidev/react-lang"
import {
  Button as OpenUiButton,
  Callout as OpenUiCallout,
  ListBlock as OpenUiListBlock,
  ListItem as OpenUiListItem,
  MarkDownRenderer as OpenUiMarkdown,
  Steps as OpenUiSteps,
  StepsItem as OpenUiStepsItem,
  openuiLibrary,
  useTheme as useOpenUiTheme,
} from "@openuidev/react-ui"
import { type CSSProperties, type ReactNode, useContext } from "react"
import { z } from "zod"

import { linkTargetHost } from "@/utils/markdown/markdownUrl"
import { stripBidiControls } from "@/utils/text/bidiControls"

import { actionLinkUrl, normalizeFileRefPath, toHttpsUrl } from "./blockActions"
import { BlockHostContext } from "./blockHost"
import styles from "./reviewComponents.module.css"

// The review library's own components. Two kinds live here:
//   1. FileRef, the one component the stock library doesn't have.
//   Plus Button, rebuilt so a button that leaves the app shows where it goes and opens nothing else.
//   2. Safe replacements for the stock components that render model text as markdown
//      (TextContent, Callout, Steps) or take an image URL (ListBlock/ListItem).
//      Stock react-markdown turns `![x](https://host/p.png)` into <img src>, which makes the
//      webview fetch a model-chosen URL, and turns links into <a target="_blank">.
//      The replacements drop <img> and route links through the host's https-only opener.

// ---------- FileRef ----------

const FileRefSchema = z.object({
  path: z.string().describe("Repo-relative file path, e.g. src/auth.ts"),
  line: z.number().optional().describe("1-based line number"),
  label: z.string().optional().describe("Link text, defaults to path:line"),
})

export const FileRef = defineComponent({
  name: "FileRef",
  props: FileRefSchema,
  description: "Clickable link that opens a file of the pull request at a line.",
  component: ({ props }) => {
    const host = useContext(BlockHostContext)
    const path = normalizeFileRefPath(props.path)
    // A model can write 0 or 12.5. Treat anything that isn't a real line as "no line".
    const isRealLine = props.line !== undefined && Number.isInteger(props.line) && props.line > 0
    const line = isRealLine ? props.line : undefined
    const location = stripBidiControls(line === undefined ? path : `${path}:${line}`)
    const label = props.label === undefined ? undefined : stripBidiControls(props.label)

    // Only PR files can open (a click jumps the diff). Any other path is plain text, so the
    // reviewer never gets a button that does nothing. The location stays readable either way.
    if (!host.canOpenFile(path)) {
      return (
        <span className={styles.fileRefText}>
          {label === undefined || label === location ? location : `${label} (${location})`}
        </span>
      )
    }

    return (
      <button
        type="button"
        className={styles.fileRef}
        title={location}
        onClick={() => host.openFile(path, line)}
      >
        {label ?? location}
      </button>
    )
  },
})

// ---------- Safe markdown ----------

type MarkdownLinkProps = {
  href?: string | undefined
  children?: ReactNode
}

// A link never navigates the webview. It opens the URL it shows, https only, through the host.
// Its target host is visible, so `[src/auth.ts:42](https://elsewhere.example)` can't pass
// for a file reference. A non-https link is plain text, since clicking it would do nothing.
function MarkdownLink({ href, children }: MarkdownLinkProps): ReactNode {
  const host = useContext(BlockHostContext)
  const url = toHttpsUrl(href)
  if (!url) return children

  return (
    <button
      type="button"
      className={styles.markdownLink}
      title={url}
      onClick={() => host.openShownLink(url)}
    >
      {children} <LinkTarget url={url} />
    </button>
  )
}

// The host a control leaves the app for, in its own left-to-right, bidi-isolated element.
// Nothing in the model-written label before it can reorder it: "(moc.buhtig.it)" stays as is.
function LinkTarget({ url }: { url: string }): ReactNode {
  return (
    <bdi dir="ltr" className={styles.linkTarget}>
      ({linkTargetHost(url)})
    </bdi>
  )
}

// The slice of a hast node this step reads: a text node, or an element with children.
type HastTextTree = { type: string; value?: string; children?: HastTextTree[] }

// Bidi controls are stripped at text boundaries: every text node of the safe markdown path (so
// nested emphasis or code inside link text is covered) and the labels of our own controls.
// Stock components (card titles, table cells, …) are not wrapped for this on purpose: a bidi
// character there only reorders its own text, which is cosmetic. What protects a link is that
// its host sits in its own isolated <bdi> after the label (LinkTarget).
function rehypeStripBidiControls() {
  return (tree: HastTextTree): void => stripTextNodes(tree)
}

function stripTextNodes(node: HastTextTree): void {
  if (node.type === "text" && node.value !== undefined) node.value = stripBidiControls(node.value)
  node.children?.forEach(stripTextNodes)
}

const SAFE_MARKDOWN_OPTIONS = {
  // Inline HTML is dropped (react-markdown keeps it out unless rehype-raw is added, this makes it
  // explicit), and <img> is removed from the tree before React ever creates the element.
  skipHtml: true,
  disallowedElements: ["img"],
  rehypePlugins: [rehypeStripBidiControls],
  components: { a: MarkdownLink },
}

type SafeMarkdownProps = {
  markdown: string
  className?: string
}

function SafeMarkdown({ markdown, className }: SafeMarkdownProps): ReactNode {
  return (
    <OpenUiMarkdown
      textMarkdown={markdown}
      options={SAFE_MARKDOWN_OPTIONS}
      {...(className ? { className } : {})}
    />
  )
}

// ---------- TextContent ----------

const TEXT_SIZES = ["small", "default", "large", "small-heavy", "large-heavy"] as const

type TextSize = (typeof TEXT_SIZES)[number]

const TEXT_SIZE_VARIABLES: Record<TextSize, string> = {
  small: "--openui-text-body-sm",
  default: "--openui-text-body-default",
  large: "--openui-text-body-lg",
  "small-heavy": "--openui-text-body-sm-heavy",
  "large-heavy": "--openui-text-body-lg-heavy",
}

// Same look as the stock TextContent (it re-points the body-size variables),
// minus KaTeX math and [n] citations, which a code review doesn't need.
function textSizeStyle(size: TextSize): CSSProperties | undefined {
  if (size === "default") return undefined

  const variable = TEXT_SIZE_VARIABLES[size]
  return {
    "--openui-text-body-default": `var(${variable})`,
    "--openui-text-body-default-letter-spacing": `var(${variable}-letter-spacing)`,
  } as CSSProperties
}

export const SafeTextContent = defineComponent({
  name: "TextContent",
  props: z.object({
    text: z.string(),
    size: z.enum(TEXT_SIZES).optional(),
  }),
  description:
    'Text block. Supports markdown. Optional size: "small" | "default" | "large" | "small-heavy" | "large-heavy".',
  component: ({ props }) => {
    const { mode } = useOpenUiTheme()
    const markdownClass =
      mode === "dark"
        ? "openui-text-content-markdown openui-text-content-markdown-dark-mode"
        : "openui-text-content-markdown"

    return (
      <div style={textSizeStyle(props.size ?? "default")}>
        <div className="openui-text-content">
          <SafeMarkdown markdown={props.text} className={markdownClass} />
        </div>
      </div>
    )
  },
})

// ---------- Callout ----------

const CALLOUT_VARIANTS = ["info", "warning", "error", "success", "neutral"] as const

type CalloutVariant = (typeof CALLOUT_VARIANTS)[number]

const CALLOUT_LOOK: Record<CalloutVariant, "info" | "warning" | "danger" | "success" | "neutral"> =
  {
    info: "info",
    warning: "warning",
    error: "danger",
    success: "success",
    neutral: "neutral",
  }

// The stock Callout also takes a $visible binding that auto-dismisses after 3 s.
// A review finding should not vanish, so that prop is gone.
export const SafeCallout = defineComponent({
  name: "Callout",
  props: z.object({
    variant: z.enum(CALLOUT_VARIANTS),
    title: z.string(),
    description: z.string(),
  }),
  description: "Callout banner for a finding, a risk or a note.",
  component: ({ props }) => (
    <OpenUiCallout
      variant={CALLOUT_LOOK[props.variant]}
      title={props.title}
      description={<SafeMarkdown markdown={props.description} />}
    />
  ),
})

// ---------- Steps ----------

export const SafeStepsItem = defineComponent({
  name: "StepsItem",
  props: z.object({
    title: z.string(),
    details: z.string(),
  }),
  description: "title and details text for one step",
  component: () => null,
})

export const SafeSteps = defineComponent({
  name: "Steps",
  props: z.object({
    items: z.array(SafeStepsItem.ref),
  }),
  description: "Step-by-step guide",
  component: ({ props }) => (
    <OpenUiSteps>
      {(props.items ?? []).map((item, index) => (
        <OpenUiStepsItem
          key={index}
          number={index + 1}
          title={item.props.title}
          details={<SafeMarkdown markdown={item.props.details} />}
        />
      ))}
    </OpenUiSteps>
  ),
})

// ---------- ListBlock / ListItem ----------

function stockComponent(name: string): NonNullable<(typeof openuiLibrary.components)[string]> {
  const component = openuiLibrary.components[name]
  if (!component)
    throw new Error(`[openui] the stock library has no ${name}, check the OpenUI version`)

  return component
}

// The stock action prop is tagged inside OpenUI, so the prompt shows `ActionExpression` and the
// parser evaluates @ToAssistant / @OpenUrl. Reuse that exact schema object instead of rebuilding it.
// The action value OpenUI's triggerAction accepts, which is what the stock action schema parses to.
type TriggerableAction = Parameters<ReturnType<typeof useTriggerAction>>[2]

function stockActionSchema(componentName: string): z.ZodType<TriggerableAction> {
  const action = stockComponent(componentName).props.shape["action"]
  if (!action) {
    throw new Error(
      `[openui] the stock ${componentName} has no action prop, check the OpenUI version`
    )
  }

  return action as z.ZodType<TriggerableAction>
}

// Same as the stock ListItem, without its `image: {src, alt}` prop.
export const SafeListItem = defineComponent({
  name: "ListItem",
  props: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    actionLabel: z.string().optional(),
    action: stockActionSchema("ListItem").optional(),
  }),
  description:
    "Item in a ListBlock — a title with an optional subtitle. When action is provided, the item becomes clickable.",
  component: () => null,
})

const LIST_SIZES = ["default", "small"] as const

export const SafeListBlock = defineComponent({
  name: "ListBlock",
  props: z.object({
    items: z.array(SafeListItem.ref),
    size: z.enum(LIST_SIZES).optional(),
  }),
  description:
    "A numbered list of items. Each item can optionally have an action. size small renders a compact list.",
  component: ({ props }) => (
    <NumberedList items={props.items ?? []} size={props.size ?? "default"} />
  ),
})

type ListItemNode = { props: z.infer<typeof SafeListItem.props> }

type NumberedListProps = {
  items: ListItemNode[]
  size: (typeof LIST_SIZES)[number]
}

// OpenUI's ListBlock injects index, variant and listHasSubtitle into each ListItem itself.
// An item with an action gets a real <button> as its title, not the stock item's onClick, which
// renders a div with role=button that Enter and Space cannot activate.
function NumberedList({ items, size }: NumberedListProps): ReactNode {
  return (
    <OpenUiListBlock variant="number" size={size}>
      {items.map((item, index) => {
        const title = stripBidiControls(item.props.title)
        const subtitle = item.props.subtitle && stripBidiControls(item.props.subtitle)
        const action = item.props.action
        const titleNode = action ? (
          <ListItemAction title={title} actionLabel={item.props.actionLabel} action={action} />
        ) : (
          title
        )

        return <OpenUiListItem key={index} title={titleNode} subtitle={subtitle} />
      })}
    </OpenUiListBlock>
  )
}

type ListItemActionProps = {
  title: string
  actionLabel: string | undefined
  action: TriggerableAction
}

// Disabled while the block streams, like Button: a cut-off URL must not open.
function ListItemAction({ title, actionLabel, action }: ListItemActionProps): ReactNode {
  const dispatchAction = useDispatchAction()
  const isStreaming = useIsStreaming()
  const url = actionLinkUrl(action)

  return (
    <button
      type="button"
      className={styles.listItemAction}
      disabled={isStreaming}
      {...(url ? { title: url } : {})}
      onClick={() => dispatchAction(title, action, url)}
    >
      {title}
      {actionLabel && (
        <span className={styles.listItemActionLabel}> · {stripBidiControls(actionLabel)}</span>
      )}
      {url && (
        <>
          {" "}
          <LinkTarget url={url} />
        </>
      )}
    </button>
  )
}

type DispatchAction = (message: string, action: TriggerableAction, url: string | null) => void

// Arms the one URL the control shows, then hands the action to OpenUI. triggerAction is async and
// can reject on an action OpenUI cannot run (a steps value that is not a list), so the rejection
// is caught here instead of reaching the window as an unhandled rejection.
function useDispatchAction(): DispatchAction {
  const host = useContext(BlockHostContext)
  const triggerAction = useTriggerAction()

  return (message, action, url) => {
    host.armActionLink(url)
    Promise.resolve(triggerAction(message, undefined, action)).catch((error: unknown) =>
      console.error("Block action failed:", error)
    )
  }
}

// ---------- Button ----------

// Same props and prompt signature as the stock Button. Rebuilt instead of wrapped so that it
// shows its target host as a separate element, carries the full URL as a title, and arms that
// one URL right before its action is dispatched.
const ReviewButtonSchema = z.object({
  label: z.string(),
  action: stockActionSchema("Button").optional(),
  variant: z.enum(["primary", "secondary", "tertiary"]).optional(),
  type: z.enum(["normal", "destructive"]).optional(),
  size: z.enum(["extra-small", "small", "medium", "large"]).optional(),
})

export const SafeButton = defineComponent({
  name: "Button",
  props: ReviewButtonSchema,
  description: "Clickable button",
  component: ({ props }) => <ReviewButton {...props} />,
})

function ReviewButton({ label, action, variant, type, size }: z.infer<typeof ReviewButtonSchema>) {
  const dispatchAction = useDispatchAction()
  const isStreaming = useIsStreaming()
  const shownLabel = stripBidiControls(label)
  const url = actionLinkUrl(action)

  return (
    <OpenUiButton
      variant={variant ?? "primary"}
      size={size ?? "medium"}
      disabled={isStreaming}
      {...(type ? { buttonType: type } : {})}
      {...(url ? { title: url } : {})}
      onClick={() => dispatchAction(shownLabel, action, url)}
    >
      {shownLabel}
      {url && (
        <>
          {" "}
          <LinkTarget url={url} />
        </>
      )}
    </OpenUiButton>
  )
}
