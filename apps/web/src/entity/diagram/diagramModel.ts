import { isBidiControl, stripBidiControls } from "@/utils/text/bidiControls"

// The diagram model the chat draws: what the agent sent, after the tolerance rules
// (docs: CONTRACT.md section 5). Plain data, no React, no OpenUI.

export const CHANGE_KINDS = ["added", "removed", "changed", "unchanged"] as const

export type ChangeKind = (typeof CHANGE_KINDS)[number]

export const NODE_KINDS = ["component", "store", "external"] as const

export type NodeKind = (typeof NODE_KINDS)[number]

// What a status is called in the ledger and the legend.
export const CHANGE_WORDS: Record<Exclude<ChangeKind, "unchanged">, string> = {
  added: "ADDED",
  removed: "REMOVED",
  changed: "CHANGED",
}

// Edge labels are tags, not sentences: in the picture, longer ones are cut to this many
// characters, "…" included. The model and the ledger keep the full label (within its budget).
export const EDGE_LABEL_MAX_CHARS = 14

// The most characters any agent string keeps, cut before anything measures or draws it.
// A long unbroken word (a hash, a minified path) is the hostile case: these keep the cost of
// wrapping and laying out bounded. Each is generous for its role in a chat diagram.
export const TEXT_BUDGETS = {
  id: 80,
  title: 160,
  label: 120,
  note: 240,
  path: 512,
} as const

export type TextBudget = (typeof TEXT_BUDGETS)[keyof typeof TEXT_BUDGETS]

// A field the agent wrote, before it is trusted: the props of one OpenUI child component.
export type RawRecord = Record<string, unknown>

// ---------- Field readers shared by both diagram kinds ----------

// Every string the agent wrote goes through here: cut to its budget, bidi controls stripped,
// whitespace trimmed. The raw value is sliced first, so a huge string is never processed whole.
export function readText(value: unknown, budget: TextBudget): string {
  // Any scalar is text to the diagram: an id 42 or true is still a name the agent chose.
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value === "boolean") return String(value)
  if (typeof value !== "string") return ""

  // Leading padding (spaces, bidi controls) is skipped first, so it cannot use up the budget.
  // Then two UTF-16 units per character cover surrogate pairs, plus room for stripped controls.
  const start = firstVisibleIndex(value)
  const head = value.slice(start, start + budget * 2 + RAW_SLACK)
  return truncateText(stripBidiControls(head).trim(), budget)
}

const RAW_SLACK = 32
// Leading padding longer than this is not skipped: the string is never scanned whole.
const LEADING_PADDING_LIMIT = 4096

function firstVisibleIndex(text: string): number {
  const limit = Math.min(text.length, LEADING_PADDING_LIMIT)
  for (let index = 0; index < limit; index += 1) {
    const character = text.charAt(index)
    if (!/\s/.test(character) && !isBidiControl(character)) return index
  }

  return limit
}

// An optional string: absent, null and empty all mean "not given".
export function readOptionalText(value: unknown, budget: TextBudget): string | null {
  const text = readText(value, budget)
  return text === "" ? null : text
}

// An unknown or missing value falls back to the default, never to an error.
export function readChange(value: unknown): ChangeKind {
  const text = readText(value, TEXT_BUDGETS.id).toLowerCase()
  return (CHANGE_KINDS as readonly string[]).includes(text) ? (text as ChangeKind) : "unchanged"
}

export function readNodeKind(value: unknown): NodeKind {
  const text = readText(value, TEXT_BUDGETS.id).toLowerCase()
  return (NODE_KINDS as readonly string[]).includes(text) ? (text as NodeKind) : "component"
}

// A line number: a positive whole number, anything else means "no line".
export function readLine(value: unknown): number | null {
  const line = typeof value === "string" ? Number(value) : value
  return typeof line === "number" && Number.isInteger(line) && line > 0 ? line : null
}

// The child components of a list prop: anything that is not an object is ignored.
export function readRecords(value: unknown): RawRecord[] {
  if (!Array.isArray(value)) return []

  return value.filter(
    (item): item is RawRecord => typeof item === "object" && item !== null && !Array.isArray(item)
  )
}

export function truncateText(text: string, maxChars: number): string {
  const characters = Array.from(text)
  if (characters.length <= maxChars) return text

  return `${characters.slice(0, maxChars - 1).join("")}…`
}

// "Showing 16 of 23 components": the visible line for every cap, never a silent drop.
export function capNotice(shown: number, total: number, noun: string): string | null {
  return total > shown ? `Showing ${shown} of ${total} ${noun}` : null
}
