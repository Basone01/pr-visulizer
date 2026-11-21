// jsdom applies no stylesheet, so layout tests read the rules themselves.
// Returns the value of `property` in the first `selector { … }` block of a raw stylesheet.
export function declarationOf(
  stylesheet: string,
  selector: string,
  property: string
): string | null {
  const start = stylesheet.indexOf(`${selector} {`)
  if (start === -1) return null

  const block = stylesheet.slice(start, stylesheet.indexOf("}", start))
  return new RegExp(`(?:^|[\\s;{])${property}:\\s*([^;]+);`).exec(block)?.[1]?.trim() ?? null
}
