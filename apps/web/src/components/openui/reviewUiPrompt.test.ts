import { openuiLibrary } from "@openuidev/react-ui"
import { describe, expect, it } from "vitest"

import { reviewLibrary } from "./reviewLibrary"
import { buildReviewUiPrompt } from "./reviewUiPrompt"

// The prompt is sent with every chat session, so its size is a running cost.
// Raise this on purpose, never by accident.
const PROMPT_SIZE_BUDGET_CHARS = 14_000

describe("buildReviewUiPrompt teaches the review library", () => {
  it("teaches FileRef for file locations", () => {
    // Arrange
    const fileRefSignature = "FileRef(path: string, line?: number, label?: string)"

    // Act
    const prompt = buildReviewUiPrompt()

    // Assert
    expect(prompt).toContain(fileRefSignature)
  })

  it("teaches prose by default and the exact openui-lang fence tag", () => {
    // Arrange
    const proseRule = "Answer in markdown prose by default."
    const fenceRule = "The fence tag must be exactly `openui-lang`"

    // Act
    const prompt = buildReviewUiPrompt()

    // Assert
    expect([prompt.includes(proseRule), prompt.includes(fenceRule)]).toEqual([true, true])
  })

  it("says a follow-up only fills the message box and sends no hidden context", () => {
    // Arrange
    const prefillOnlyRule =
      "clicking one only puts its message text into the reviewer's message box"
    const noHiddenContextRule =
      "The context argument of @ToAssistant is ignored and no hidden data is ever sent"

    // Act
    const prompt = buildReviewUiPrompt()

    // Assert
    expect([prompt.includes(prefillOnlyRule), prompt.includes(noHiddenContextRule)]).toEqual([
      true,
      true,
    ])
  })

  it("teaches when to draw a diagram: lead a change summary with one Diagram, steps over time as a SequenceDiagram", () => {
    // Arrange
    const leadWithDiagram = "lead with ONE Diagram of the parts of the system the PR touches"
    const componentsNotFiles = "not functions, not one node per file"
    const budget = "At most 8 nodes and 10 edges"
    const sequenceRule = "is a SequenceDiagram (at most 5 participants, 12 messages)"
    const notTheFileList = "Never draw a diagram that only restates the file list."
    const preambleNamesDiagrams = "only when a diagram, a table"

    // Act
    const prompt = buildReviewUiPrompt()

    // Assert
    const rules = [
      leadWithDiagram,
      componentsNotFiles,
      budget,
      sequenceRule,
      notTheFileList,
      preambleNamesDiagrams,
    ]
    expect(rules.filter((rule) => !prompt.includes(rule))).toEqual([])
  })

  it("teaches the diagram title and labels as required, in position, with the exact change values", () => {
    // Arrange
    const taught = [
      "Diagram(title: string, nodes: DiagramNode[], edges: DiagramEdge[], groups?: DiagramGroup[])",
      'DiagramNode(id: string, label: string, change?: "added" | "removed" | "changed" | "unchanged",',
      "SequenceDiagram(title: string, participants: SequenceParticipant[], messages: SequenceMessage[])",
      "SequenceMessage(from: string, to: string, label: string, change?:",
      "change is exactly added, removed, changed or unchanged (lower case)",
    ]

    // Act
    const prompt = buildReviewUiPrompt()

    // Assert
    expect(taught.filter((text) => !prompt.includes(text))).toEqual([])
  })

  it("defines node and edge statuses by the diff, leaves tests out, and limits paths to the diff's files", () => {
    // Arrange
    const rules = [
      "Node change: added = new in this PR, removed = deleted by it, changed = this PR edits its own code.",
      "A neighbour that only receives new data or a new call stays unchanged.",
      "Edge change: added = this PR makes the source call or depend on the target where it did not before, even if the target already existed.",
      "changed = this PR edits the call site itself (different arguments or data there). An untouched call that only carries a payload with more fields stays unchanged.",
      "never tests",
      "Set path only to a file in this PR's diff (git diff --stat), on every node whose code is in one, never to any other file, even one in the repository.",
    ]

    // Act
    const prompt = buildReviewUiPrompt()

    // Assert
    expect(rules.filter((rule) => !prompt.includes(rule))).toEqual([])
  })

  it("no longer tells the agent its entire response must be openui-lang", () => {
    // Arrange
    const wholeResponseRule = "ENTIRE response"

    // Act
    const prompt = buildReviewUiPrompt()

    // Assert
    expect(prompt).not.toContain(wholeResponseRule)
  })

  it("mentions no stock component that the review library removed", () => {
    // Arrange
    const removedNames = Object.keys(openuiLibrary.components).filter(
      (name) => !(name in reviewLibrary.components)
    )

    // Act
    const prompt = buildReviewUiPrompt()

    // Assert
    const mentioned = removedNames.filter((name) => new RegExp(`\\b${name}\\(`).test(prompt))
    expect(mentioned).toEqual([])
  })

  it("stays under the prompt size budget", () => {
    // Arrange
    const budget = PROMPT_SIZE_BUDGET_CHARS

    // Act
    const prompt = buildReviewUiPrompt()

    // Assert
    expect(prompt.length).toBeLessThan(budget)
  })
})
