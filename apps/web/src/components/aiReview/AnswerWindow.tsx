import { useEffect, useState } from "react"

import {
  loadAnswerReport,
  openAnswerFile,
  subscribeAnswerReports,
} from "@/service/terminal/answerWindow"

import { MarkdownContent } from "@/components/markdown/MarkdownContent"

import styles from "./AnswerWindow.module.css"

export function AnswerWindow({ sessionId }: { sessionId: string }) {
  const [report, setReport] = useState<Awaited<ReturnType<typeof loadAnswerReport>>>(null)
  const [error, setError] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    let receivedEvent = false
    let unlisten: (() => void) | null = null
    void subscribeAnswerReports(sessionId, (nextReport) => {
      if (!active) return

      receivedEvent = true
      setReport(nextReport)
    })
      .then((stop) => {
        if (!active) {
          stop()
          return null
        }

        unlisten = stop
        return loadAnswerReport(sessionId)
      })
      .then((initialReport) => {
        if (active && initialReport && !receivedEvent) setReport(initialReport)
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError))
      })

    return () => {
      active = false
      unlisten?.()
    }
  }, [sessionId])

  if (error)
    return (
      <p className={styles.error} role="alert">
        Couldn&apos;t load answer: {error}
      </p>
    )
  if (!report) return <p className={styles.empty}>Waiting for Codex to render an answer…</p>

  return (
    <main className={styles.window}>
      <header className={styles.header}>
        <h1>{report.title}</h1>
        <time dateTime={report.updatedAt}>{new Date(report.updatedAt).toLocaleTimeString()}</time>
      </header>
      <MarkdownContent
        source={report.markdown}
        html="sanitized"
        fileReferences={report.fileRefs}
        onOpenFile={(fileReference) => {
          setFileError(null)
          void openAnswerFile(sessionId, fileReference.path, fileReference.line).catch(
            (openError: unknown) => {
              setFileError(openError instanceof Error ? openError.message : String(openError))
            }
          )
        }}
      />
      {report.fileRefs.length > 0 && (
        <section className={styles.references} aria-label="Referenced files">
          <h2>Referenced files</h2>
          <ul>
            {report.fileRefs.map((fileRef) => (
              <li key={`${fileRef.path}:${fileRef.line ?? ""}`}>
                <button
                  type="button"
                  onClick={() => {
                    setFileError(null)
                    void openAnswerFile(sessionId, fileRef.path, fileRef.line).catch(
                      (openError: unknown) => {
                        setFileError(
                          openError instanceof Error ? openError.message : String(openError)
                        )
                      }
                    )
                  }}
                >
                  {fileRef.label ?? fileRef.path}
                  {fileRef.line ? `:${fileRef.line}` : ""}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {fileError && (
        <p className={styles.error} role="alert">
          Couldn&apos;t open file: {fileError}
        </p>
      )}
    </main>
  )
}
