// Provider requests are untrusted data. These provider-neutral UI shapes describe one exact
// operation for an explicit reviewer decision; they never describe a reusable shell capability.
export type AiPermissionRequest =
  | {
      id: string
      runId: string
      kind: "command"
      command: string
      workingDirectory: string
      reason: string
      expectedEffect: string
    }
  | {
      id: string
      runId: string
      kind: "mcp-startup"
      server: string
      executable: string
      arguments: string[]
      environmentNames: string[]
      dataAccess: string
      networkScope: string
      reason: string
    }
  | {
      id: string
      runId: string
      kind: "mcp-tool-call"
      server: string
      tool: string
      arguments: string
      requestedData: string
      possibleSideEffects: string
      reason: string
    }

export type AiPermissionDecision = {
  requestId: string
  decision: "allow-once" | "deny"
}

export type AiInstructionSource = "global" | "repository" | "custom-agent"

// The app reads these selected files/declarations as text only. `declaredPermissions` is an
// inspection label from a custom-agent definition, never a capability grant.
export type AiInstructionInspection = {
  id: string
  source: AiInstructionSource
  path: string
  content: string
  declaredPermissions: string[]
}

export function instructionSourceLabel(source: AiInstructionSource): string {
  if (source === "global") return "Global review preference"
  if (source === "repository") return "Repository review rule"
  return "Custom-agent definition"
}

// This pure boundary intentionally returns the supplied text verbatim. It does not parse, load,
// execute, or allow instruction content to influence permissions or provider configuration.
export function inspectSelectedInstructions(
  instructions: readonly AiInstructionInspection[]
): AiInstructionInspection[] {
  return instructions.map((instruction) => ({
    ...instruction,
    declaredPermissions: [...instruction.declaredPermissions],
  }))
}
