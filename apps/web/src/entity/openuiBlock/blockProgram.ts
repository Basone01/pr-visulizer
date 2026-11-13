// The statements of one openui-lang block, as plain data: enough to give a block that has no
// `root` statement a root over its top-level components. A model sometimes splits one program
// across two fences, and the second has no root. Reading the statements out of the source is
// lang-core's job (components/openui/blockStatements.ts): this module only decides, so it stays
// free of OpenUI and testable on its own.

export type ProgramStatement = {
  name: string
  // The component a `name = TypeName(…)` statement builds, or null for any other value.
  component: string | null
  // Other names this statement's expression uses as values.
  references: string[]
}

export const ROOT_STATEMENT = "root"

export function hasRootStatement(statements: ProgramStatement[]): boolean {
  return statements.some((statement) => statement.name === ROOT_STATEMENT)
}

// The components a missing root would list: built by a component that can draw on its own (not a
// DiagramNode or a Series, which only mean something inside their parent), used by no other
// statement, each name once, in source order.
export function unreferencedComponents(
  statements: ProgramStatement[],
  isStandalone: (component: string) => boolean
): string[] {
  const referenced = new Set(statements.flatMap((statement) => statement.references))
  const entries = statements
    .filter((statement) => statement.component !== null && isStandalone(statement.component))
    .map((statement) => statement.name)
    .filter((name) => !referenced.has(name))

  return [...new Set(entries)]
}

// The root statement to add when the block has none and has something to put in one.
// Null when there is nothing to build a root from.
export function synthesizedRoot(
  statements: ProgramStatement[],
  rootComponent: string,
  isStandalone: (component: string) => boolean
): string | null {
  if (hasRootStatement(statements)) return null

  const entries = unreferencedComponents(statements, isStandalone)
  if (entries.length === 0) return null

  return `${ROOT_STATEMENT} = ${rootComponent}([${entries.join(", ")}])`
}
