import { describe, expect, it } from "vitest"

import { escapeHiddenCharacters, stripBidiControls } from "./bidiControls"

describe("stripBidiControls removes characters that can reorder what follows", () => {
  it("strips every bidi control and keeps the visible text", () => {
    // Arrange
    const label = "Open ‮‪‫‬‭⁦⁧⁨⁩‎‏؜docs"

    // Act
    const stripped = stripBidiControls(label)

    // Assert
    const expected = "Open docs"
    expect(stripped).toBe(expected)
  })
})

describe("escapeHiddenCharacters shows what a text really holds", () => {
  it("escapes bidi, zero-width and control characters and keeps newline and tab", () => {
    // Arrange
    const text = "a\u202Eb\u200Bc\u0007d\ne\tf"

    // Act
    const escaped = escapeHiddenCharacters(text)

    // Assert
    const expected = { text: "a\\u{202E}b\\u{200B}c\\u{0007}d\ne\tf", hadHidden: true }
    expect(escaped).toEqual(expected)
  })

  it.each([
    ["soft_hyphen", "\u00AD"],
    ["line_separator", "\u2028"],
    ["paragraph_separator", "\u2029"],
    ["deprecated_format_control", "\u206A"],
    ["variation_selector", "\uFE0F"],
    ["supplementary_variation_selector", "\u{E0100}"],
    ["tag_character", "\u{E0041}"],
    ["no_break_space", "\u00A0"],
    ["ideographic_space", "\u3000"],
    ["hangul_filler", "\u3164"],
    ["halfwidth_hangul_filler", "\uFFA0"],
    ["hangul_choseong_filler", "\u115F"],
    ["combining_grapheme_joiner", "\u034F"],
    ["private_use", "\uE000"],
    ["lone_surrogate", "\uD800"],
    ["carriage_return", "\r"],
  ])("escapes_a_%s", (_name, hiddenCharacter) => {
    // Arrange
    const text = `./run${hiddenCharacter}.sh`

    // Act
    const escaped = escapeHiddenCharacters(text)

    // Assert
    const codePoint = hiddenCharacter.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")
    const expected = { text: `./run\\u{${codePoint}}.sh`, hadHidden: true }
    expect(escaped).toEqual(expected)
  })

  it("thai_text_with_vowels_and_tone_marks_passes_through_unchanged", () => {
    // Arrange
    const thaiText = 'echo "ตรวจสอบโค้ดก่อนรวม น้ำ ผู้ใหญ่ ที่นี่" && git status'

    // Act
    const escaped = escapeHiddenCharacters(thaiText)

    // Assert
    const expected = { text: thaiText, hadHidden: false }
    expect(escaped).toEqual(expected)
  })

  it("ordinary_spaces_newlines_and_tabs_are_not_escaped", () => {
    // Arrange
    const text = "git status\n\tgit diff --stat"

    // Act
    const escaped = escapeHiddenCharacters(text)

    // Assert
    const expected = { text, hadHidden: false }
    expect(escaped).toEqual(expected)
  })
})
