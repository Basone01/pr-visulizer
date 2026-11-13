// Pure rules for what a click inside an OpenUI block may do. No React, no OpenUI import,
// so the security policy is testable on its own and readable in one place.

const ALLOWED_LINK_PROTOCOL = "https:"

// Only https leaves the app. http, file:, javascript:, custom schemes and junk all map to null.
export function toHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null

  try {
    const url = new URL(raw)
    return url.protocol === ALLOWED_LINK_PROTOCOL ? url.toString() : null
  } catch {
    return null
  }
}

// The slice of OpenUI's ActionEvent these rules read. Declared here so the rules
// don't depend on the library's types (external-library rule).
export type BlockActionEvent = {
  type: string
  params?: unknown
  humanFriendlyMessage?: string
}

export type BlockActionRoute =
  { kind: "follow-up"; text: string } | { kind: "open-url"; url: string } | { kind: "ignore" }

const CONTINUE_CONVERSATION = "continue_conversation"
const OPEN_URL = "open_url"

export function routeBlockAction(event: BlockActionEvent): BlockActionRoute {
  if (event.type === CONTINUE_CONVERSATION) {
    const text = event.humanFriendlyMessage?.trim() ?? ""
    return text ? { kind: "follow-up", text } : { kind: "ignore" }
  }

  if (event.type === OPEN_URL) {
    const url = toHttpsUrl(readUrlParam(event.params))
    return url ? { kind: "open-url", url } : { kind: "ignore" }
  }

  return { kind: "ignore" }
}

// @OpenUrl("https://…") arrives as { url: "https://…" }.
function readUrlParam(params: unknown): unknown {
  if (typeof params !== "object" || params === null) return undefined

  return (params as { url?: unknown }).url
}

// ---------- The one URL a control may open ----------

// The single https URL a click on this action may open, or null. The control shows this URL's
// host, arms it on click, and the opener refuses every other URL (see createArmedLinkOpener).
// It mirrors how OpenUI's triggerAction turns an action into open_url events:
//   plan:    { steps: [{ type: "open_url", url }, …] }  → the first https open_url step
//   literal: { type: "open_url", url?, params?: { url } } → `url` if set, else `params.url`
// Like triggerAction, any action with a `steps` key is a plan. A plan whose steps is not an array
// opens nothing there (null steps become a follow-up, an object throws), so it has no link here.
export function actionLinkUrl(action: unknown): string | null {
  if (!isObject(action)) return null

  if ("steps" in action) {
    const steps = action["steps"]
    if (!Array.isArray(steps)) return null

    const stepUrls = steps.map((step: unknown) => toHttpsUrl(stepOpenUrl(step)))
    return stepUrls.find((url) => url !== null) ?? null
  }

  return toHttpsUrl(literalOpenUrl(action))
}

function stepOpenUrl(step: unknown): unknown {
  if (!isObject(step) || step["type"] !== OPEN_URL) return undefined

  return step["url"]
}

// triggerAction builds `params = { ...action.params }` and then overwrites `params.url` with
// `action.url` when that is truthy, so a top-level url wins.
function literalOpenUrl(action: Record<string, unknown>): unknown {
  if (action["type"] !== OPEN_URL) return undefined

  return action["url"] || readUrlParam(action["params"])
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export type ArmedLinkOpener = {
  // A control that shows `url` was clicked: allow exactly that URL to open once.
  arm: (url: string | null) => void
  // An open_url event arrived: true only for the armed URL, which is then used up.
  takeArmed: (url: string) => boolean
}

// OpenUI reports every @OpenUrl step of a click as its own event, and the event no longer says
// which control fired it. So the control arms the one URL it shows before the click is dispatched,
// and only that URL may open: one URL per click, and never one the reviewer wasn't shown.
export function createArmedLinkOpener(): ArmedLinkOpener {
  let armedUrl: string | null = null

  return {
    arm: (url) => {
      armedUrl = url
    },
    takeArmed: (url) => {
      const isArmed = armedUrl !== null && url === armedUrl
      armedUrl = null
      return isArmed
    },
  }
}

// ---------- File references ----------

// The one form of a FileRef path used both to ask the host whether it can open the file and to
// open it, so "./src/a.ts" and "src/a.ts" are the same PR file: trimmed, backslashes turned
// into "/", and every leading "./" removed. Nothing else changes (no "..", case or slash folding).
export function normalizeFileRefPath(path: string): string {
  return path
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(\.\/)+/, "")
}
