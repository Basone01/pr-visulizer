import { defineComponent } from "@openuidev/react-lang"
import {
  BarChartCondensed as OpenUiBarChart,
  IconButton as OpenUiIconButton,
  Table as OpenUiTable,
  TableBody as OpenUiTableBody,
  TableCell as OpenUiTableCell,
  TableHead as OpenUiTableHead,
  TableHeader as OpenUiTableHeader,
  TableRow as OpenUiTableRow,
  openuiLibrary,
} from "@openuidev/react-ui"
import { type ReactNode, useState } from "react"
import { z } from "zod"

import { type BarSeries, HorizontalBarChart } from "@/components/chart/HorizontalBarChart"

import styles from "./reviewDataComponents.module.css"

// Table and BarChart, with the same props and prompt signatures as the stock ones.
// They are rebuilt because the stock versions lay out badly in a chat-width panel:
//   - The stock Table drops each Col's type, and OpenUI sets white-space: nowrap on every cell,
//     so one long note made the table about 1000 px wide at any panel width. Here every cell
//     knows its column type, so text columns can wrap while numbers stay on one line.
//     It uses OpenUI's plain Table, not ScrollableTable: ScrollableTable sets an inline
//     `width: max-content` once the table overflows, which unwraps every cell again (measured:
//     1271 px at a 240 px block). The plain Table scrolls in its own overflow:auto container.
//   - The stock BarChart cuts long x-axis labels at the end, which removes the file name from a
//     path. Short names keep the stock chart with angled labels, longer ones get our own
//     horizontal bars (components/chart), which show every name in full.

function stockRef(name: string): z.ZodType {
  const component = openuiLibrary.components[name]
  if (!component)
    throw new Error(`[openui] the stock library has no ${name}, check the OpenUI version`)

  return component.ref as z.ZodType
}

// A parsed child component as the renderer receives it: { props: { … } }.
function childProps(node: unknown): Record<string, unknown> {
  if (typeof node !== "object" || node === null) return {}

  const props = (node as { props?: unknown }).props
  return typeof props === "object" && props !== null ? (props as Record<string, unknown>) : {}
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return value === undefined || value === null ? [] : [value]
}

// ---------- Table ----------

const TABLE_PAGE_SIZE = 10

type ColumnKind = "text" | "number" | "action"

type TableColumn = {
  label: string
  kind: ColumnKind
  cells: unknown[]
}

const CELL_CLASS: Record<ColumnKind, string | undefined> = {
  text: styles.textCell,
  number: styles.numberCell,
  action: styles.actionCell,
}

function readColumns(rawColumns: unknown): TableColumn[] {
  return asList(rawColumns)
    .map(childProps)
    .filter((column) => Object.keys(column).length > 0)
    .map((column) => ({
      label: String(column["label"] ?? ""),
      kind:
        column["type"] === "number" ? "number" : column["type"] === "action" ? "action" : "text",
      cells: asList(column["data"]),
    }))
}

export const SafeTable = defineComponent({
  name: "Table",
  props: z.object({ columns: z.array(stockRef("Col")) }),
  description: "Data table — column-oriented. Each Col holds its own data array.",
  component: ({ props, renderNode }) => (
    <ReviewTable columns={readColumns(props.columns)} renderNode={renderNode} />
  ),
})

type ReviewTableProps = {
  columns: TableColumn[]
  renderNode: (value: unknown) => ReactNode
}

function ReviewTable({ columns, renderNode }: ReviewTableProps): ReactNode {
  const [page, setPage] = useState(0)
  if (columns.length === 0) return null

  const rowCount = Math.max(...columns.map((column) => column.cells.length))
  const pageCount = Math.ceil(rowCount / TABLE_PAGE_SIZE)
  const shownPage = Math.min(page, Math.max(0, pageCount - 1))
  const firstRow = shownPage * TABLE_PAGE_SIZE
  const rowIndexes = Array.from(
    { length: Math.min(TABLE_PAGE_SIZE, rowCount - firstRow) },
    (_, offset) => firstRow + offset
  )

  return (
    <div>
      <OpenUiTable>
        <OpenUiTableHeader>
          <OpenUiTableRow>
            {columns.map((column, columnIndex) => (
              <OpenUiTableHead
                key={columnIndex}
                className={CELL_CLASS[column.kind]}
                {...(column.kind === "number" ? { align: "right" as const } : {})}
              >
                {column.label}
              </OpenUiTableHead>
            ))}
          </OpenUiTableRow>
        </OpenUiTableHeader>
        <OpenUiTableBody>
          {rowIndexes.map((rowIndex) => (
            <OpenUiTableRow key={rowIndex}>
              {columns.map((column, columnIndex) => (
                <OpenUiTableCell
                  key={columnIndex}
                  className={CELL_CLASS[column.kind]}
                  {...(column.kind === "number" ? { align: "right" as const } : {})}
                >
                  {renderCell(column.cells[rowIndex], renderNode)}
                </OpenUiTableCell>
              ))}
            </OpenUiTableRow>
          ))}
        </OpenUiTableBody>
      </OpenUiTable>
      {pageCount > 1 && (
        <div className={styles.pager}>
          <OpenUiIconButton
            aria-label="Previous page"
            size="small"
            variant="secondary"
            icon={<span aria-hidden="true">‹</span>}
            disabled={shownPage === 0}
            onClick={() => setPage(shownPage - 1)}
          />
          <span className={styles.pageNumber}>
            {shownPage + 1} / {pageCount}
          </span>
          <OpenUiIconButton
            aria-label="Next page"
            size="small"
            variant="secondary"
            icon={<span aria-hidden="true">›</span>}
            disabled={shownPage >= pageCount - 1}
            onClick={() => setPage(shownPage + 1)}
          />
        </div>
      )}
    </div>
  )
}

// A cell is a plain value, or a component (a Tag, a FileRef) that renders through OpenUI.
function renderCell(cell: unknown, renderNode: (value: unknown) => ReactNode): ReactNode {
  if (typeof cell === "object" && cell !== null) return renderNode(cell)

  return String(cell ?? "")
}

// ---------- BarChart ----------

type ChartRow = Record<string, string | number>

// { category: "auth", Findings: 3, Fixed: 1 } per label, one key per Series.
function barChartRows(labels: unknown, series: unknown): ChartRow[] {
  const seriesProps = asList(series).map(childProps)

  return asList(labels).map((label, index) => {
    const row: ChartRow = { category: String(label) }
    for (const { category, values } of seriesProps) {
      const value = Array.isArray(values) ? values[index] : undefined
      if (typeof category === "string" && typeof value === "number") row[category] = value
    }
    return row
  })
}

// OpenUI's vertical chart cuts angled labels at the end, so it is kept only for names it shows
// whole. Measured in the app's webview at a 240 px block: 6 characters stay uncut with up to
// 10 categories (7 cuts the first label at 10 categories, 8 at 8), and past 10 categories it
// leaves some labels out entirely. Anything else gets the horizontal bars, which never cut.
const VERTICAL_LABEL_MAX_CHARS = 6
const VERTICAL_MAX_CATEGORIES = 10

function needsHorizontalBars(categories: string[]): boolean {
  const longestLabel = Math.max(0, ...categories.map((category) => Array.from(category).length))
  return longestLabel > VERTICAL_LABEL_MAX_CHARS || categories.length > VERTICAL_MAX_CATEGORIES
}

// The axis labels say what the numbers are: "Findings by File", or whichever one was given.
function axisCaption(xLabel: string | undefined, yLabel: string | undefined): string | null {
  if (xLabel && yLabel) return `${yLabel} by ${xLabel}`

  return yLabel || xLabel || null
}

// The series as the horizontal chart takes them: one value per category, in category order.
function barSeries(series: unknown, rows: ChartRow[]): BarSeries[] {
  return asList(series)
    .map(childProps)
    .flatMap(({ category }) => {
      if (typeof category !== "string") return []

      const values = rows.map((row) => {
        const value = row[category]
        return typeof value === "number" ? value : 0
      })
      return [{ name: category, values }]
    })
}

export const SafeBarChart = defineComponent({
  name: "BarChart",
  props: z.object({
    labels: z.array(z.string()),
    series: z.array(stockRef("Series")),
    variant: z.enum(["grouped", "stacked"]).optional(),
    xLabel: z.string().optional(),
    yLabel: z.string().optional(),
    height: z.number().optional(),
  }),
  description: "Vertical bars; use for comparing values across categories with one or more series",
  component: ({ props }) => {
    const rows = barChartRows(props.labels, props.series)
    if (rows.length === 0) return null

    const categories = rows.map((row) => String(row["category"]))
    if (needsHorizontalBars(categories)) {
      return (
        <HorizontalBarChart
          categories={categories}
          series={barSeries(props.series, rows)}
          caption={axisCaption(props.xLabel, props.yLabel)}
        />
      )
    }

    return (
      <OpenUiBarChart
        data={rows}
        categoryKey="category"
        tickVariant="angled"
        isAnimationActive={false}
        {...(props.variant ? { variant: props.variant } : {})}
        {...(props.xLabel ? { xAxisLabel: props.xLabel } : {})}
        {...(props.yLabel ? { yAxisLabel: props.yLabel } : {})}
        {...(props.height ? { height: props.height } : {})}
      />
    )
  },
})
