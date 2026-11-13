import { z } from "zod"

// The {name} tokens a custom shortcut template may use.
export const SHORTCUT_PLACEHOLDERS = [
  "prUrl",
  "title",
  "baseSha",
  "headSha",
  "selectedFile",
] as const
type ShortcutPlaceholder = (typeof SHORTCUT_PLACEHOLDERS)[number]

export const NO_FILE_SELECTED_TEXT = "No file is selected."

export type TerminalPromptShortcutContext = {
  prUrl: string
  title: string
  baseSha: string
  headSha: string
  selectedFile: string | null
}

export type TerminalPromptShortcut = {
  id: string
  label: string
  buildPrompt: (context: TerminalPromptShortcutContext) => string
}

// Mirrors the sem-pr skill's PR body minus its test sections.
// Curly placeholders such as {TICKET-ID} are literal text for the agent to fill in.
function buildPrDescriptionPrompt({
  prUrl,
  title,
  baseSha,
  headSha,
}: TerminalPromptShortcutContext): string {
  return [
    "Draft a pull request description for this PR, the way the sem-pr skill does, but without any test section.",
    `PR: ${prUrl}`,
    `Title: ${title}`,
    `Base commit: ${baseSha}`,
    `Head commit: ${headSha}`,
    "",
    "Steps:",
    `1. Run \`command -v sem && sem diff -v --from ${baseSha} --to ${headSha}\`. If sem is missing, use \`git diff ${baseSha}...${headSha}\` instead. Also run \`git log --oneline ${baseSha}..${headSha}\`.`,
    "2. Find the JIRA ticket in the PR title or the head branch name, pattern [A-Z]+-[0-9]+. Omit the JIRA section when there is none.",
    "3. Group the semantic changes by intent: new API surface (added types, constants, functions, interfaces), behavior changes (modified function or method bodies), data model changes (modified struct fields), configuration or wiring (modified variables such as maps, slices, registries). Each group becomes one Changes bullet.",
    "4. Write the description with exactly this template:",
    "",
    "# [{TICKET-ID}] {Concise summary, max 10 words}",
    "",
    "## System design",
    "- {What a user can now do or see, one short line}",
    "",
    "## Changes",
    "- {What code made that happen, one short line, entity name in backticks at the end}",
    "",
    "## JIRA",
    "- [{TICKET-ID}](https://wisesight.atlassian.net/browse/{TICKET-ID})",
    "",
    "Rules: every bullet is one sentence with no sub-bullets. System design describes observable behavior with no internal type or function names, so a non-engineer can read it. Changes is written for a maintainer, one bullet per intent group, entity name from the sem diff in backticks at the end. A Changes bullet that only rewords a System design bullet is forbidden. English only. No AI attribution footer.",
    "5. Call render_answer with the title line as the title and the full description as markdown, then confirm briefly in the terminal. Do not create, push, or update any PR.",
  ].join("\n")
}

const prDescriptionShortcut: TerminalPromptShortcut = {
  id: "pr-description",
  label: "PR description",
  buildPrompt: buildPrDescriptionPrompt,
}

// The chat draws a Diagram block from data the agent sends, the terminal cannot show one.
function buildDiagramChangesPrompt({
  prUrl,
  title,
  baseSha,
  headSha,
}: TerminalPromptShortcutContext): string {
  return [
    "Summarize what this PR changes in the system as one diagram first: the components it touches, marking what was added, changed and removed.",
    "Draw the diagram in your chat reply, not through render_answer.",
    "Then give at most five short bullets on what a reviewer should look at first, each with a clickable file location.",
    `PR: ${prUrl}`,
    `Title: ${title}`,
    `Base commit: ${baseSha}`,
    `Head commit: ${headSha}`,
  ].join("\n")
}

const diagramChangesShortcut: TerminalPromptShortcut = {
  id: "diagram-changes",
  label: "Diagram changes",
  buildPrompt: buildDiagramChangesPrompt,
}

// Shortcuts are data: each surface's header renders one button per entry.
export const TERMINAL_PROMPT_SHORTCUTS: ReadonlyArray<TerminalPromptShortcut> = [
  prDescriptionShortcut,
]

export const CHAT_PROMPT_SHORTCUTS: ReadonlyArray<TerminalPromptShortcut> = [
  ...TERMINAL_PROMPT_SHORTCUTS,
  diagramChangesShortcut,
]

export const customTerminalPromptShortcutSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1).max(40),
  template: z
    .string()
    .min(1)
    .max(16 * 1024),
})
export type CustomTerminalPromptShortcut = z.infer<typeof customTerminalPromptShortcutSchema>

const PLACEHOLDER_PATTERN = new RegExp(`\\{(${SHORTCUT_PLACEHOLDERS.join("|")})\\}`, "g")

// Only the known placeholders are replaced, so literal braces such as {TICKET-ID} survive.
export function renderShortcutTemplate(
  template: string,
  context: TerminalPromptShortcutContext
): string {
  const values: Record<ShortcutPlaceholder, string> = {
    prUrl: context.prUrl,
    title: context.title,
    baseSha: context.baseSha,
    headSha: context.headSha,
    selectedFile: context.selectedFile ?? NO_FILE_SELECTED_TEXT,
  }

  return template.replace(PLACEHOLDER_PATTERN, (_match, name: ShortcutPlaceholder) => values[name])
}

export function toPromptShortcut(custom: CustomTerminalPromptShortcut): TerminalPromptShortcut {
  return {
    id: custom.id,
    label: custom.label,
    buildPrompt: (context) => renderShortcutTemplate(custom.template, context),
  }
}
