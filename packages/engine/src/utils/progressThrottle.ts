// Throttle a counted-progress reporter (generic helper): forward a call only every `every`
// increments, and always on the final one (`done === total`). The deep engine scans a whole
// repo — thousands of files — so an un-throttled per-file callback would spam the UI with
// thousands of events; this collapses that to ~one every 25 files while still landing the
// exact final count (docs/architecture.md §6).
export function throttleByCount(
  every: number,
  report: (done: number, total: number) => void
): (done: number, total: number) => void {
  return (done, total) => {
    if (done === total || done % every === 0) report(done, total)
  }
}
