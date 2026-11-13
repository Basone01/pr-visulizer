// Bidi controls can visually reorder what follows them, e.g. turn "(moc.buhtig.it)" into
// "(ti.github.com)": LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI, LRM/RLM and the Arabic letter mark.
const BIDI_CONTROLS = /[‪-‮⁦-⁩‎‏؜]/g

export function stripBidiControls(text: string): string {
  return text.replace(BIDI_CONTROLS, "")
}

const BIDI_CONTROL = /^[‪-‮⁦-⁩‎‏؜]$/

export function isBidiControl(character: string): boolean {
  return BIDI_CONTROL.test(character)
}

// Characters that change what text looks like without being visible (CONTRACT.md §10, F6):
// controls, format characters, line and paragraph separators, private-use and lone surrogates,
// every space other than U+0020, variation selectors, the combining grapheme joiner and the
// blank fillers. Ordinary combining marks are left alone, so Thai vowels and tone marks stay.
const HIDDEN_CHARACTERS =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Zs}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u034F\u115F\u1160\u3164\uFFA0]/gu
// Members of the classes above that are part of ordinary text.
const VISIBLE_EXCEPTIONS = new Set(["\n", "\t", " "])

// Shows every hidden character as a visible \u{XXXX} escape instead of dropping it, so a
// reviewer sees exactly what text holds, for example a command they are asked to approve.
export function escapeHiddenCharacters(text: string): { text: string; hadHidden: boolean } {
  let hadHidden = false
  const escaped = text.replace(HIDDEN_CHARACTERS, (character) => {
    if (VISIBLE_EXCEPTIONS.has(character)) return character

    hadHidden = true
    const codePoint = character.codePointAt(0) ?? 0
    return `\\u{${codePoint.toString(16).toUpperCase().padStart(4, "0")}}`
  })

  return { text: escaped, hadHidden }
}
