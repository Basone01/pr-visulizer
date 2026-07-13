// Compact relative-time label for the open-PR list's updated-at (docs/tauri-architecture.md
// §5). Pure: `now` is injected so it is deterministic in tests. Returns "" for a value that
// isn't a valid timestamp, so a bad field degrades to blank rather than "NaN ago".

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY
const YEAR = 365 * DAY

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""

  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000))

  if (seconds < MINUTE) return "just now"
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m ago`
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h ago`
  if (seconds < MONTH) return `${Math.floor(seconds / DAY)}d ago`
  if (seconds < YEAR) return `${Math.floor(seconds / MONTH)}mo ago`

  return `${Math.floor(seconds / YEAR)}y ago`
}
