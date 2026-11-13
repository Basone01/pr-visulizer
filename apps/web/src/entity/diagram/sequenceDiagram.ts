import {
  type ChangeKind,
  TEXT_BUDGETS,
  capNotice,
  readChange,
  readRecords,
  readText,
} from "./diagramModel"

// A request or job moving through steps over time: participants as columns, messages in order.

export type SequenceParticipant = {
  id: string
  label: string
  change: ChangeKind
}

export type SequenceMessage = {
  id: string
  from: string
  to: string
  label: string
  change: ChangeKind
  reply: boolean
}

export type SequenceDiagram = {
  title: string
  participants: SequenceParticipant[]
  messages: SequenceMessage[]
  notices: string[]
}

// Hard render caps. The agent is taught smaller budgets (5 participants, 12 messages).
export const SEQUENCE_LIMITS = { participants: 8, messages: 24 } as const

export type RawSequenceDiagram = {
  title: unknown
  participants: unknown
  messages: unknown
}

// Same tolerance rules as the flow diagram: a message naming an unknown participant creates it,
// a duplicate id keeps the first, and past a cap the first N are kept with a visible notice.
export function normalizeSequenceDiagram(raw: RawSequenceDiagram): SequenceDiagram {
  const declaredParticipants = readParticipants(raw.participants)
  const declaredMessages = readMessages(raw.messages)
  // Only a message inside the cap can create a participant: one past it is never drawn.
  const allParticipants = withImplicitParticipants(
    declaredParticipants,
    declaredMessages.slice(0, SEQUENCE_LIMITS.messages)
  )

  const participants = allParticipants.slice(0, SEQUENCE_LIMITS.participants)
  const keptIds = new Set(participants.map((participant) => participant.id))
  const drawableMessages = declaredMessages.filter(
    (message) => keptIds.has(message.from) && keptIds.has(message.to)
  )
  const messages = drawableMessages.slice(0, SEQUENCE_LIMITS.messages)

  const participantNotice = capNotice(participants.length, allParticipants.length, "participants")
  const messageNotice = capNotice(messages.length, declaredMessages.length, "messages")

  return {
    title: readText(raw.title, TEXT_BUDGETS.title) || "Sequence",
    participants,
    messages,
    notices: [participantNotice, messageNotice].filter(
      (notice): notice is string => notice !== null
    ),
  }
}

function readParticipants(value: unknown): SequenceParticipant[] {
  const participants: SequenceParticipant[] = []
  const seenIds = new Set<string>()

  for (const record of readRecords(value)) {
    const id = readText(record["id"], TEXT_BUDGETS.id)
    if (!id || seenIds.has(id)) continue

    seenIds.add(id)
    participants.push({
      id,
      label: readText(record["label"], TEXT_BUDGETS.label) || id,
      change: readChange(record["change"]),
    })
  }

  return participants
}

function readMessages(value: unknown): SequenceMessage[] {
  const messages: SequenceMessage[] = []

  for (const record of readRecords(value)) {
    const from = readText(record["from"], TEXT_BUDGETS.id)
    const to = readText(record["to"], TEXT_BUDGETS.id)
    if (!from || !to) continue

    messages.push({
      id: `message-${messages.length}`,
      from,
      to,
      label: readText(record["label"], TEXT_BUDGETS.label),
      change: readChange(record["change"]),
      reply: readReply(record["reply"]),
    })
  }

  return messages
}

function readReply(value: unknown): boolean {
  return value === true || value === "true"
}

function withImplicitParticipants(
  participants: SequenceParticipant[],
  messages: SequenceMessage[]
): SequenceParticipant[] {
  const allParticipants = [...participants]
  const knownIds = new Set(participants.map((participant) => participant.id))

  for (const endpoint of messages.flatMap((message) => [message.from, message.to])) {
    if (knownIds.has(endpoint)) continue

    knownIds.add(endpoint)
    allParticipants.push({ id: endpoint, label: endpoint, change: "unchanged" })
  }

  return allParticipants
}
