// The text a reviewer sees for a caught value, which may not be an Error at all.
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
