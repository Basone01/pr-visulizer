import type { LanguageRegistration } from "shiki/core"

import brunoGrammar from "./bruno.tmLanguage.json"

// Vendored unchanged from github.com/usebruno/bruno-ide-extensions,
// packages/vscode/syntaxes/bruno.tmLanguage.json (MIT), fetched 2026-10-14.
// Its embedded includes we don't load (markdown, xml, graphql) degrade to plain text.
export const brunoLanguage = brunoGrammar as unknown as LanguageRegistration
