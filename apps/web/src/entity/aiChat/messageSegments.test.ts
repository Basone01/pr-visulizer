import { describe, expect, it } from "vitest"

import { type MessageSegment, splitMessageSegments } from "./messageSegments"

describe("splitMessageSegments", () => {
  it("splits_prose_and_openui_lang_fences_in_order", () => {
    // Arrange
    const message = [
      "The change touches two files.",
      "```openui-lang",
      'root = FileRef("src/app.ts", 42, "app")',
      "```",
      "Both look safe.",
    ].join("\n")

    // Act
    const segments = splitMessageSegments(message, { streaming: false })

    // Assert
    const expected: MessageSegment[] = [
      { kind: "prose", text: "The change touches two files." },
      { kind: "openui", code: 'root = FileRef("src/app.ts", 42, "app")', closed: true },
      { kind: "prose", text: "Both look safe." },
    ]
    expect(segments).toEqual(expected)
  })

  it("keeps_another_languages_fence_inside_the_prose", () => {
    // Arrange
    const message = ["Run this:", "```ts", "const a = 1", "```", "Done."].join("\n")

    // Act
    const segments = splitMessageSegments(message, { streaming: false })

    // Assert
    const expected: MessageSegment[] = [{ kind: "prose", text: message }]
    expect(segments).toEqual(expected)
  })

  it("keeps_an_openui_lang_fence_nested_in_another_fence_as_prose", () => {
    // Arrange
    const message = ["````markdown", "```openui-lang", "root = 1", "```", "````"].join("\n")

    // Act
    const segments = splitMessageSegments(message, { streaming: false })

    // Assert
    const expected: MessageSegment[] = [{ kind: "prose", text: message }]
    expect(segments).toEqual(expected)
  })

  it("treats_only_the_exact_openui_lang_tag_as_a_block", () => {
    // Arrange
    const message = ["```openui-language", "root = 1", "```"].join("\n")

    // Act
    const segments = splitMessageSegments(message, { streaming: false })

    // Assert
    const expected: MessageSegment[] = [{ kind: "prose", text: message }]
    expect(segments).toEqual(expected)
  })

  it("marks_an_openui_lang_fence_still_open_at_the_end_as_not_closed", () => {
    // Arrange
    const streamingMessage = ["Here is the summary:", "```openui-lang", "root = Card("].join("\n")

    // Act
    const segments = splitMessageSegments(streamingMessage, { streaming: true })

    // Assert
    const expected: MessageSegment[] = [
      { kind: "prose", text: "Here is the summary:" },
      { kind: "openui", code: "root = Card(", closed: false },
    ]
    expect(segments).toEqual(expected)
  })

  it("an_empty_message_has_no_segments", () => {
    // Arrange
    const message = ""

    // Act
    const segments = splitMessageSegments(message, { streaming: false })

    // Assert
    expect(segments).toEqual([])
  })

  it("a_crlf_message_still_splits_out_its_openui_lang_block", () => {
    // Arrange
    const message = "Hi\r\n```openui-lang\r\nroot = 1\r\n```\r\nBye"

    // Act
    const segments = splitMessageSegments(message, { streaming: false })

    // Assert
    const expected: MessageSegment[] = [
      { kind: "prose", text: "Hi" },
      { kind: "openui", code: "root = 1", closed: true },
      { kind: "prose", text: "Bye" },
    ]
    expect(segments).toEqual(expected)
  })

  it("a_streaming_opener_that_may_become_openui_lang_is_held_back_from_the_prose", () => {
    // Arrange
    const partialOpeners = ["Here:\n```", "Here:\n```open", "Here:\n```openui-lang"]

    // Act
    const segmentsPerDelta = partialOpeners.map((message) =>
      splitMessageSegments(message, { streaming: true })
    )

    // Assert
    const expected: MessageSegment[] = [{ kind: "prose", text: "Here:" }]
    expect(segmentsPerDelta).toEqual([expected, expected, expected])
  })

  it("a_finished_message_keeps_a_trailing_fence_line_in_the_prose", () => {
    // Arrange
    const message = "Here:\n```"

    // Act
    const segments = splitMessageSegments(message, { streaming: false })

    // Assert
    const expected: MessageSegment[] = [{ kind: "prose", text: message }]
    expect(segments).toEqual(expected)
  })

  it("a_streaming_opener_for_another_language_is_shown_at_once", () => {
    // Arrange
    const message = "Run:\n```ts"

    // Act
    const segments = splitMessageSegments(message, { streaming: true })

    // Assert
    const expected: MessageSegment[] = [{ kind: "prose", text: message }]
    expect(segments).toEqual(expected)
  })
})
