import type { CSSProperties, ReactNode } from "react"

import styles from "./HorizontalBarChart.module.css"

// Horizontal bars in plain HTML and CSS: one row per category, the full name on its own line
// above the row's bars. Nothing is shortened, so two names never look the same, a file name is
// never cut, and nothing can leave the box at any width. Every value is printed, so the chart
// needs no tooltip, and each value names its series, so colour is never the only cue.

export type BarSeries = { name: string; values: number[] }

export type HorizontalBarChartProps = {
  categories: string[]
  series: BarSeries[]
  // What the numbers are, e.g. "Findings by File". Null shows no caption.
  caption: string | null
}

// Series colours, in order: tokens that carry no review meaning (the status colours mean added,
// changed and removed in this app), so a bar never reads as a status.
const SERIES_COLORS = [
  "var(--accent)",
  "var(--syn-type)",
  "var(--syn-func)",
  "var(--syn-const)",
  "var(--muted)",
]

export function HorizontalBarChart({
  categories,
  series,
  caption,
}: HorizontalBarChartProps): ReactNode {
  const largestValue = Math.max(0, ...series.flatMap((oneSeries) => oneSeries.values))
  const hasSeveralSeries = series.length > 1
  const valueTextOf = (oneSeries: BarSeries, value: number): string =>
    hasSeveralSeries ? `${oneSeries.name} ${value}` : String(value)
  // Every bar track is the same width (the line minus the widest value text), so bar lengths
  // compare across rows.
  const widestValueChars = Math.max(
    ...series.flatMap((oneSeries) =>
      categories.map((_, index) => valueTextOf(oneSeries, oneSeries.values[index] ?? 0).length)
    )
  )
  const chartStyle = { "--value-width": `${widestValueChars}ch` } as CSSProperties

  return (
    <figure className={styles.chart} style={chartStyle}>
      {caption && <figcaption className={styles.caption}>{caption}</figcaption>}
      {hasSeveralSeries && (
        <ul className={styles.legend} aria-label="Series">
          {series.map((oneSeries, index) => (
            <li key={oneSeries.name} className={styles.legendItem}>
              <span className={styles.swatch} style={colorOf(index)} />
              {oneSeries.name}
            </li>
          ))}
        </ul>
      )}
      <ol className={styles.rows} aria-label="Bar chart rows">
        {categories.map((category, categoryIndex) => (
          <li key={`${categoryIndex}-${category}`} className={styles.row}>
            <span className={styles.category}>{category}</span>
            {series.map((oneSeries, seriesIndex) => {
              const value = oneSeries.values[categoryIndex] ?? 0

              return (
                <div key={oneSeries.name} className={styles.barLine}>
                  <span className={styles.track}>
                    <span
                      className={styles.bar}
                      style={{ ...colorOf(seriesIndex), width: barWidth(value, largestValue) }}
                    />
                  </span>
                  <span className={styles.value}>{valueTextOf(oneSeries, value)}</span>
                </div>
              )
            })}
          </li>
        ))}
      </ol>
    </figure>
  )
}

function colorOf(seriesIndex: number): CSSProperties {
  return { background: SERIES_COLORS[seriesIndex % SERIES_COLORS.length] }
}

// A share of the bar track; zero and negative values draw no bar but keep their printed value.
function barWidth(value: number, largestValue: number): string {
  if (largestValue <= 0 || value <= 0) return "0%"

  return `${(value / largestValue) * 100}%`
}
