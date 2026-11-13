import { parseExpression, split, tokenize, walkAST } from "@openuidev/lang-core"

import type { ProgramStatement } from "@/entity/openuiBlock/blockProgram"

// A block's statements as lang-core 1.1.0 itself reads them: its tokenizer drops strings and
// comments, its splitter continues a statement on a line that starts with "?" or ":", and its
// expression parser says which words are references. Lives here, not in entity/, so lang-core
// stays in the lazy OpenUI chunk.

type Expression = ReturnType<typeof parseExpression>

export function readStatements(code: string): ProgramStatement[] {
  return split(tokenize(code)).map((statement) => {
    const expression = parseStatement(statement.tokens)
    const source = code.slice(statement.start, statement.end)
    const isComponent = expression?.k === "Comp" && !isBuiltInCall(source)
    return {
      name: String(statement.id),
      component: isComponent ? expression.name : null,
      references: referencesIn(expression),
    }
  })
}

// lang-core's AST writes `@ToAssistant(…)` as a call named "ToAssistant", like a component.
// Only the "@" in the source tells a built-in action or function from one.
function isBuiltInCall(statementSource: string): boolean {
  const expressionSource = statementSource.slice(statementSource.indexOf("=") + 1)
  return expressionSource.trimStart().startsWith("@")
}

// lang-core turns garbage into a Null node, but a throw on one statement must not hide the rest.
function parseStatement(tokens: Parameters<typeof parseExpression>[0]): Expression | null {
  try {
    return parseExpression(tokens)
  } catch {
    return null
  }
}

// The parser already tells a used name (a Ref node) from an object key, a property after "."
// and a call's name, so no rule of our own decides that.
function referencesIn(expression: Expression | null): string[] {
  if (expression === null) return []

  const references: string[] = []
  walkAST(expression, (node) => {
    if (node.k === "Ref") references.push(node.n)
  })
  return references
}
