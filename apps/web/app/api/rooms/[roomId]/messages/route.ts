import { desc, eq, getDb, inArray } from "@workspace/db/postgres"
import {
  messageReactions,
  messages,
  participants,
} from "@workspace/db/schema"

import { bearerToken, requireMember, UnauthorizedError } from "@/lib/auth"
import { ASSISTANT_AUTHOR } from "@/lib/persona"
import type { ChatMessage, MessageReactionSummary } from "@/lib/types"

// Authenticated message history for a room. Membership is proven with the
// bearer sessionToken (Authorization header only — no query-string fallback,
// see bearerToken). Returns the last 100 messages in chronological (ascending)
// order, each enriched with its author (assistant/system rows collapse to the
// "Rendezvous" persona) and its aggregated reactions.

const HISTORY_LIMIT = 100

export async function GET(
  request: Request,
  ctx: { params: Promise<{ roomId: string }> }
): Promise<Response> {
  const { roomId } = await ctx.params

  let myParticipantId: string
  try {
    const { participant } = await requireMember(bearerToken(request), roomId)
    myParticipantId = participant.id
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return new Response("Unauthorized", { status: 401 })
    }
    throw err
  }

  const db = getDb()

  // Most-recent 100, then reversed to ascending for display. participants is
  // LEFT-joined because assistant/system rows have a null participantId.
  const rows = await db
    .select({
      id: messages.id,
      participantId: messages.participantId,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
      authorName: participants.displayName,
      authorColor: participants.color,
    })
    .from(messages)
    .leftJoin(participants, eq(messages.participantId, participants.id))
    .where(eq(messages.roomId, roomId))
    .orderBy(desc(messages.createdAt))
    .limit(HISTORY_LIMIT)
  rows.reverse()

  const messageIds = rows.map((r) => r.id)

  // emoji reactions for just these messages, one row per (message, reactor),
  // aggregated in JS into per-emoji summaries (cheap at <=100 messages).
  const reactionRows =
    messageIds.length > 0
      ? await db
          .select({
            messageId: messageReactions.messageId,
            emoji: messageReactions.emoji,
            participantId: messageReactions.participantId,
            reactorName: participants.displayName,
          })
          .from(messageReactions)
          .innerJoin(
            participants,
            eq(messageReactions.participantId, participants.id)
          )
          .where(inArray(messageReactions.messageId, messageIds))
          .orderBy(messageReactions.createdAt)
      : []

  // messageId -> emoji -> summary. Insertion order of the inner map preserves
  // first-reacted ordering of the emoji chips.
  const byMessage = new Map<string, Map<string, MessageReactionSummary>>()
  for (const r of reactionRows) {
    let emojis = byMessage.get(r.messageId)
    if (!emojis) {
      emojis = new Map()
      byMessage.set(r.messageId, emojis)
    }
    let summary = emojis.get(r.emoji)
    if (!summary) {
      summary = { emoji: r.emoji, count: 0, reactedByMe: false, names: [] }
      emojis.set(r.emoji, summary)
    }
    summary.count += 1
    summary.names.push(r.reactorName)
    if (r.participantId === myParticipantId) summary.reactedByMe = true
  }

  const result: ChatMessage[] = rows.map((r) => {
    const author =
      r.participantId && r.authorName
        ? { name: r.authorName, color: r.authorColor ?? ASSISTANT_AUTHOR.color }
        : ASSISTANT_AUTHOR
    const emojis = byMessage.get(r.id)
    return {
      id: r.id,
      roomId,
      participantId: r.participantId,
      role: r.role,
      content: r.content,
      createdAt: r.createdAt.toISOString(),
      author,
      reactions: emojis ? Array.from(emojis.values()) : [],
    }
  })

  return Response.json(result)
}
