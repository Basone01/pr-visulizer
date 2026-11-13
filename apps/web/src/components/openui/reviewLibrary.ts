import {
  type ComponentGroup,
  type Library,
  type PromptOptions,
  createLibrary,
} from "@openuidev/react-lang"
// Everything comes from the package root on purpose. The `genui-lib` subpath is a separate bundle
// with its own copy of ThemeProvider's React context, so its components would not see our theme.
import { openuiLibrary } from "@openuidev/react-ui"

import {
  FileRef,
  SafeButton,
  SafeCallout,
  SafeListBlock,
  SafeListItem,
  SafeSteps,
  SafeStepsItem,
  SafeTextContent,
} from "./reviewComponents"
import { SafeBarChart, SafeTable } from "./reviewDataComponents"
import {
  Diagram,
  DiagramEdge,
  DiagramGroup,
  DiagramNode,
  SequenceDiagram,
  SequenceMessage,
  SequenceParticipant,
} from "./reviewDiagramComponents"

// The code-review subset of OpenUI's stock library. Everything else is removed, which also
// removes every image and media component (Image, ImageBlock, ImageGallery, Carousel, …).
const KEPT_STOCK_COMPONENTS = new Set([
  "Stack",
  "Card",
  "CardHeader",
  "Tabs",
  "TabItem",
  "Accordion",
  "AccordionItem",
  "Separator",
  "CodeBlock",
  "TagBlock",
  "Tag",
  // Tag.icon accepts only Icon, so extend() refuses to remove it. Icons are bundled lucide chunks.
  "Icon",
  "Col",
  "Series",
  "PieChart",
  "Buttons",
])

// Stock components whose rendering we replace (see reviewComponents.tsx and
// reviewDataComponents.tsx for why).
const SAFE_OVERRIDES = [
  SafeTextContent,
  SafeCallout,
  SafeSteps,
  SafeStepsItem,
  SafeListBlock,
  SafeListItem,
  SafeButton,
  SafeTable,
  SafeBarChart,
]

const OVERRIDDEN_NAMES = new Set(SAFE_OVERRIDES.map((component) => component.name))

const REMOVED_STOCK_COMPONENTS = Object.keys(openuiLibrary.components).filter(
  (name) => !KEPT_STOCK_COMPONENTS.has(name) && !OVERRIDDEN_NAMES.has(name)
)

// extend() rebinds every content union (Card.children, TabItem.content, …) to the overrides,
// and the slots let FileRef and the diagrams appear wherever a card or a tab holds content.
const CONTENT_SLOTS = ["Card", "TabItem", "AccordionItem"]

const extendedLibrary: Library = openuiLibrary.extend({
  components: {
    remove: REMOVED_STOCK_COMPONENTS,
    override: SAFE_OVERRIDES,
    add: [
      { component: FileRef, slots: CONTENT_SLOTS },
      { component: Diagram, slots: CONTENT_SLOTS },
      { component: SequenceDiagram, slots: CONTENT_SLOTS },
      DiagramNode,
      DiagramEdge,
      DiagramGroup,
      SequenceParticipant,
      SequenceMessage,
    ],
  },
})

// The stock group notes still teach Form, Modal and LineChart after remove(),
// so the lean library brings its own groups.
const REVIEW_COMPONENT_GROUPS: ComponentGroup[] = [
  {
    name: "Layout",
    components: [
      "Stack",
      "Tabs",
      "TabItem",
      "Accordion",
      "AccordionItem",
      "Steps",
      "StepsItem",
      "Separator",
    ],
  },
  {
    name: "Content",
    components: ["Card", "CardHeader", "TextContent", "Callout", "CodeBlock", "FileRef"],
  },
  {
    name: "Tables",
    components: ["Table", "Col"],
    notes: [
      '- Table is COLUMN-oriented: Table([Col("File", files), Col("Findings", counts, "number")]).',
    ],
  },
  {
    name: "Diagrams",
    components: [
      "Diagram",
      "DiagramNode",
      "DiagramEdge",
      "DiagramGroup",
      "SequenceDiagram",
      "SequenceParticipant",
      "SequenceMessage",
    ],
    notes: [
      "- Send data only: the app lays out and draws. Ids link edges to nodes.",
      "- change is exactly added, removed, changed or unchanged (lower case), default unchanged. A rewired relationship is a removed edge plus an added edge.",
      '- Skip an optional argument with null: DiagramNode("q", "Job queue", "added", null, "src/queue.ts").',
    ],
  },
  { name: "Charts", components: ["BarChart", "Series", "PieChart"] },
  { name: "Lists and tags", components: ["ListBlock", "ListItem", "TagBlock", "Tag", "Icon"] },
  { name: "Buttons", components: ["Buttons", "Button"] },
]

// Every block's root statement is `root = Stack(…)`.
export const REVIEW_ROOT_COMPONENT = "Stack"

// Parts that only mean something inside their parent (a node in a Diagram, a Series in a
// BarChart). A root made up for a block that has none never lists them on their own.
const SUB_PART_COMPONENTS = new Set([
  "Col",
  "Series",
  "TabItem",
  "AccordionItem",
  "StepsItem",
  "Tag",
  "ListItem",
  "DiagramNode",
  "DiagramEdge",
  "DiagramGroup",
  "SequenceParticipant",
  "SequenceMessage",
])

// A name the library does not define still counts, so the renderer names it in the block's note.
export function canDrawOnItsOwn(component: string): boolean {
  return !SUB_PART_COMPONENTS.has(component)
}

// Typed as Library on purpose: the inferred type names a pnpm-internal path (TS2742).
export const reviewLibrary: Library = createLibrary({
  root: REVIEW_ROOT_COMPONENT,
  components: Object.values(extendedLibrary.components),
  componentGroups: REVIEW_COMPONENT_GROUPS,
})

const REVIEW_PREAMBLE = [
  "You are a code-review assistant inside a pull-request review app.",
  "Answer in markdown prose by default.",
  "Add an openui-lang fenced block only when a diagram, a table, a chart, a steps list or a grouped file list makes the answer clearer.",
  "Never put the whole answer in a block: explain in prose, and use a block only for the part that is structured.",
  "The fence tag must be exactly `openui-lang` (three backticks, then openui-lang). Any other tag is shown as plain code.",
  "Every block is a separate, complete program: it starts with its own root = Stack(...) and defines every name it uses. Names are never shared between blocks. Two diagrams are one block whose root lists both, or two blocks that each have their own root.",
].join("\n")

const REVIEW_EXAMPLE = [
  "root = Stack([card])",
  "card = Card([header, table, risk, ref])",
  'header = CardHeader("Review summary", "3 files changed")',
  'table = Table([Col("File", ["src/auth.ts", "src/db.ts"]), Col("Findings", [2, 0], "number")])',
  'risk = Callout("warning", "Missing guard", "Token refresh skips the expiry check.")',
  'ref = FileRef("src/auth.ts", 42, "Open the refresh handler")',
].join("\n")

const REVIEW_RULES = [
  "In prose-like parts of a block (cards, lists, callouts), point at a file with FileRef so the reviewer can open it. A Table cell and a DiagramNode path take the plain repo-relative path string.",
  "For what a PR changes, a summary or an overview, lead with ONE Diagram of the parts of the system the PR touches, then explain in prose. Nodes are components (modules, services, stores, screens, jobs), not functions, not one node per file, never tests. Node change: added = new in this PR, removed = deleted by it, changed = this PR edits its own code. A neighbour that only receives new data or a new call stays unchanged. Edge change: added = this PR makes the source call or depend on the target where it did not before, even if the target already existed. removed = this PR deletes that call. changed = this PR edits the call site itself (different arguments or data there). An untouched call that only carries a payload with more fields stays unchanged. Give each changed node a note. Set path only to a file in this PR's diff (git diff --stat), on every node whose code is in one, never to any other file, even one in the repository. Keep an untouched neighbour only if needed to read the change. At most 8 nodes and 10 edges (more is two diagrams), edge labels at most 14 characters.",
  "A request or job that moves through steps over time is a SequenceDiagram (at most 5 participants, 12 messages). If a 3-column table says the same thing, use a Table. Never draw a diagram that only restates the file list.",
  // The stock Action text says buttons "send" and that @ToAssistant context is "hidden data".
  // In this app a follow-up only fills the reviewer's message box, and nothing hidden is ever sent.
  "Follow-up buttons (no action, or @ToAssistant) do not send anything: clicking one only puts its message text into the reviewer's message box, and the reviewer decides whether to send it. The context argument of @ToAssistant is ignored and no hidden data is ever sent, so write each follow-up as a complete, self-contained question that names the file and line it is about.",
]

const DIAGRAM_EXAMPLE = [
  "root = Stack([d])",
  'd = Diagram("Order dispatch moves to a queue", [api, queue, mail], [e1, e2])',
  'api = DiagramNode("api", "Orders API", "changed", "direct send → enqueue", "src/api/orders.ts")',
  'queue = DiagramNode("queue", "Job queue", "added", "new", null, "store")',
  'mail = DiagramNode("mail", "Mailer", "removed", "replaced by the worker")',
  'e1 = DiagramEdge("api", "queue", "enqueue", "added")',
  'e2 = DiagramEdge("api", "mail", "send", "removed")',
].join("\n")

// An example as a whole reply: a line of prose, then the program in its fence. The prompt prints
// examples as they are, and a bare program invited a reply with no fence.
function asReply(prose: string, program: string): string {
  return [prose, "```openui-lang", program, "```"].join("\n")
}

// Inline mode is off: its stock section assumes one persistent dashboard ("output ONLY the
// changed/new statements", "a question gets text only"), which made a model split one program
// across two fences. Off, lang-core 1.1.0 prints no section about it at all, and the preamble
// above says how blocks work here.
export const reviewPromptOptions: PromptOptions = {
  inlineMode: false,
  preamble: REVIEW_PREAMBLE,
  examples: [
    asReply(
      "Two findings, both in src/auth.ts. The refresh guard is the one to fix:",
      REVIEW_EXAMPLE
    ),
    asReply("Order dispatch moves from a direct send to a queue:", DIAGRAM_EXAMPLE),
  ],
  additionalRules: REVIEW_RULES,
}
