export type Point = { x: number; y: number }

// An SVG path through orthogonal points with every elbow rounded by `radius` (smaller on short
// segments, so a corner never overshoots). Points that are collinear with their neighbours are
// dropped first.
//   [{0,0},{40,0},{40,30}] with radius 8 → "M 0 0 L 32 0 Q 40 0 40 8 L 40 30"
export function roundedOrthogonalPath(points: Point[], radius: number): string {
  const corners = withoutStraightRuns(points)
  const [start, ...rest] = corners
  if (!start) return ""

  const commands = [`M ${start.x} ${start.y}`]
  for (let index = 1; index < corners.length - 1; index += 1) {
    const previous = corners[index - 1] as Point
    const corner = corners[index] as Point
    const next = corners[index + 1] as Point
    const cornerRadius = Math.min(
      radius,
      distance(previous, corner) / 2,
      distance(corner, next) / 2
    )

    const entry = towards(corner, previous, cornerRadius)
    const exit = towards(corner, next, cornerRadius)
    commands.push(`L ${entry.x} ${entry.y}`, `Q ${corner.x} ${corner.y} ${exit.x} ${exit.y}`)
  }

  const end = rest[rest.length - 1]
  if (end) commands.push(`L ${end.x} ${end.y}`)
  return commands.join(" ")
}

function withoutStraightRuns(points: Point[]): Point[] {
  return points.filter((point, index) => {
    const previous = points[index - 1]
    const next = points[index + 1]
    if (!previous || !next) return true

    const isDuplicate = previous.x === point.x && previous.y === point.y
    const isStraight =
      (previous.x === point.x && point.x === next.x) ||
      (previous.y === point.y && point.y === next.y)
    return !isDuplicate && !isStraight
  })
}

function distance(from: Point, to: Point): number {
  return Math.hypot(to.x - from.x, to.y - from.y)
}

// The point `length` away from `from` in the direction of `to`.
function towards(from: Point, to: Point, length: number): Point {
  const total = distance(from, to)
  if (total === 0) return from

  return {
    x: round(from.x + ((to.x - from.x) / total) * length),
    y: round(from.y + ((to.y - from.y) / total) * length),
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

// The midpoint of the longest segment: where a label reads best on a routed edge.
export function longestSegmentMidpoint(points: Point[]): Point | null {
  let best: { length: number; midpoint: Point } | null = null
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1] as Point
    const to = points[index] as Point
    const length = distance(from, to)
    if (!best || length > best.length) {
      best = { length, midpoint: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 } }
    }
  }

  return best?.midpoint ?? null
}
