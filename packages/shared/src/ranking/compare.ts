// Lexicographic string comparison, ascending. Shared by the static sort and the
// dynamic best-next as their final total-order tie-break (path ascending).
export function comparePathAscending(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}
