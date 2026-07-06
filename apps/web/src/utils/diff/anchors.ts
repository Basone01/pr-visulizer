import type { ChangedSymbol, SymbolOccurrence } from "@pr-visulizer/shared"

import type { AnchorIndex, OccurrenceRef, SymbolAnchor } from "@/entity/anchor"

// Map AnalysisResult.occurrences onto diff lines (docs/architecture.md §10, §5 step 7).
// Pure: the same occurrences + symbols always yield the same index. No extra
// analysis pass — occurrences already carry every def/usage site.

function firstDefinition(occurrences: SymbolOccurrence[]): OccurrenceRef | null {
  const definition = occurrences.find((occurrence) => occurrence.role === "definition")
  if (!definition) return null

  return { path: definition.path, line: definition.line }
}

function usagesOf(occurrences: SymbolOccurrence[]): OccurrenceRef[] {
  return occurrences
    .filter((occurrence) => occurrence.role === "usage")
    .map((occurrence) => ({ path: occurrence.path, line: occurrence.line }))
}

// The identifier text to underline comes from the ChangedSymbol, keyed by symbolId.
function nameById(symbols: ChangedSymbol[]): Map<string, string> {
  return new Map(symbols.map((symbol) => [symbol.id, symbol.name]))
}

function groupBySymbol(occurrences: SymbolOccurrence[]): Map<string, SymbolOccurrence[]> {
  const bySymbol = new Map<string, SymbolOccurrence[]>()

  for (const occurrence of occurrences) {
    const list = bySymbol.get(occurrence.symbolId)
    if (list) {
      list.push(occurrence)
      continue
    }

    bySymbol.set(occurrence.symbolId, [occurrence])
  }

  return bySymbol
}

// Build the per-file, per-line anchor index the diff renderer overlays on top of
// the syntax + status layers.
export function buildAnchorIndex(
  occurrences: SymbolOccurrence[],
  symbols: ChangedSymbol[]
): AnchorIndex {
  const names = nameById(symbols)
  const bySymbol = groupBySymbol(occurrences)

  const index: AnchorIndex = new Map()

  for (const [symbolId, symbolOccurrences] of bySymbol) {
    const name = names.get(symbolId) ?? symbolId.split("#")[1] ?? symbolId
    const definition = firstDefinition(symbolOccurrences)
    const usages = usagesOf(symbolOccurrences)

    for (const occurrence of symbolOccurrences) {
      const isUsage = occurrence.role === "usage"

      // A usage underlines when its definition exists; a definition underlines
      // when it has at least one usage.
      const hasCounterpart = isUsage ? definition !== null : usages.length > 0

      const anchor: SymbolAnchor = {
        symbolId,
        name,
        role: occurrence.role,
        line: occurrence.line,
        hasCounterpart,
        definition: isUsage ? definition : null,
        usages: isUsage ? [] : usages,
      }

      insert(index, occurrence.path, occurrence.line, anchor)
    }
  }

  return index
}

function insert(index: AnchorIndex, path: string, line: number, anchor: SymbolAnchor): void {
  const byLine = index.get(path) ?? new Map<number, SymbolAnchor[]>()
  const anchors = byLine.get(line) ?? []

  anchors.push(anchor)
  byLine.set(line, anchors)
  index.set(path, byLine)
}

// Convenience for the renderer: anchors on a given file line, or an empty array.
export function anchorsForLine(index: AnchorIndex, path: string, headLine: number): SymbolAnchor[] {
  return index.get(path)?.get(headLine) ?? []
}
