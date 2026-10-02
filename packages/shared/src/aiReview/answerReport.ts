import { z } from "zod"

export const answerFileReferenceSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  label: z.string().min(1).optional(),
})

export const answerReportSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1),
  title: z.string().min(1),
  markdown: z.string(),
  fileRefs: z.array(answerFileReferenceSchema).default([]),
  updatedAt: z.string().datetime(),
})

export type AnswerReport = z.infer<typeof answerReportSchema>
