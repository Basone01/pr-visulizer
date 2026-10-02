import {
  type AiInstructionInspection,
  type AiPermissionDecision,
  type AiPermissionRequest,
  inspectSelectedInstructions,
  instructionSourceLabel,
} from "@/entity/aiReviewPermissions"

import styles from "@/components/tray/SubmitReviewDialog.module.css"

type AiPermissionDialogProps = {
  request: AiPermissionRequest
  selectedInstructions: readonly AiInstructionInspection[]
  deciding: boolean
  error: string | null
  onDecision: (decision: AiPermissionDecision) => void
}

function requestTitle(request: AiPermissionRequest): string {
  if (request.kind === "command") return "Approve repository command?"
  if (request.kind === "mcp-startup") return "Approve MCP server startup?"
  return "Approve MCP tool call?"
}

function PermissionDetails({ request }: { request: AiPermissionRequest }) {
  if (request.kind === "command") {
    return (
      <div className={styles.summary}>
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>Command</span>
          <code className={styles.summaryValue}>{request.command}</code>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>Working directory</span>
          <code className={styles.summaryValue}>{request.workingDirectory}</code>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>Expected effect</span>
          <span className={styles.summaryValue}>{request.expectedEffect}</span>
        </div>
      </div>
    )
  }

  if (request.kind === "mcp-startup") {
    return (
      <div className={styles.summary}>
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>Server</span>
          <span className={styles.summaryValue}>{request.server}</span>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>Executable</span>
          <code className={styles.summaryValue}>{request.executable}</code>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>Arguments</span>
          <code className={styles.summaryValue}>{request.arguments.join(" ") || "(none)"}</code>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>Environment names</span>
          <span className={styles.summaryValue}>
            {request.environmentNames.join(", ") || "(none)"}
          </span>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>Data access</span>
          <span className={styles.summaryValue}>{request.dataAccess}</span>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.summaryLabel}>Network scope</span>
          <span className={styles.summaryValue}>{request.networkScope}</span>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.summary}>
      <div className={styles.summaryRow}>
        <span className={styles.summaryLabel}>Server</span>
        <span className={styles.summaryValue}>{request.server}</span>
      </div>
      <div className={styles.summaryRow}>
        <span className={styles.summaryLabel}>Tool</span>
        <span className={styles.summaryValue}>{request.tool}</span>
      </div>
      <div className={styles.summaryRow}>
        <span className={styles.summaryLabel}>Arguments</span>
        <code className={styles.summaryValue}>{request.arguments}</code>
      </div>
      <div className={styles.summaryRow}>
        <span className={styles.summaryLabel}>Requested data</span>
        <span className={styles.summaryValue}>{request.requestedData}</span>
      </div>
      <div className={styles.summaryRow}>
        <span className={styles.summaryLabel}>Possible side effects</span>
        <span className={styles.summaryValue}>{request.possibleSideEffects}</span>
      </div>
    </div>
  )
}

// This dialog is a display-and-decision boundary only. It does not start a process, grant a
// shell capability, execute inspected instruction text, or persist an approval for another action.
export function AiPermissionDialog({
  request,
  selectedInstructions,
  deciding,
  error,
  onDecision,
}: AiPermissionDialogProps) {
  const instructions = inspectSelectedInstructions(selectedInstructions)

  return (
    <div className={styles.backdrop}>
      <div
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-label={requestTitle(request)}
      >
        <h3 className={styles.title}>{requestTitle(request)}</h3>
        <p className={styles.body}>Reason: {request.reason}</p>
        <PermissionDetails request={request} />
        <p className={styles.warning}>
          Approval applies only to this exact request. Edits, dependency installation, and automatic
          network fetches remain prohibited.
        </p>

        {instructions.length > 0 && (
          <section aria-labelledby="ai-selected-instructions">
            <h4 className={styles.title} id="ai-selected-instructions">
              Selected instruction data
            </h4>
            {instructions.map((instruction) => (
              <details key={instruction.id}>
                <summary>
                  {instructionSourceLabel(instruction.source)} · {instruction.path}
                </summary>
                <pre>{instruction.content}</pre>
                {instruction.declaredPermissions.length > 0 && (
                  <p className={styles.body}>
                    Declared permissions: {instruction.declaredPermissions.join(", ")}
                  </p>
                )}
              </details>
            ))}
          </section>
        )}

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            disabled={deciding}
            onClick={() => onDecision({ requestId: request.id, decision: "deny" })}
          >
            Deny
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={deciding}
            onClick={() => onDecision({ requestId: request.id, decision: "allow-once" })}
          >
            {deciding ? "Deciding…" : "Allow once"}
          </button>
        </div>
      </div>
    </div>
  )
}
