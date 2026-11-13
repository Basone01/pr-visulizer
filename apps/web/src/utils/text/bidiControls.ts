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
