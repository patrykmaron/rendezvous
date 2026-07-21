"use server"

import { and, eq, getDb } from "@workspace/db/postgres"
import { withRoomRevision } from "@workspace/db/revision"
import { messageReactions, messages } from "@workspace/db/schema"

import {
  NeedsOriginsError,
  postSystemMessage,
  startAnalysis,
} from "@/lib/agent-trigger"
import { requireMember } from "@/lib/auth"
import { broadcastRoomEvent } from "@/lib/liveblocks-server"
import { isReactionEmoji } from "@/lib/reactions"
import type { ChatMessage } from "@/lib/types"

// A message triggers the agent when it @-mentions it (word-boundary, so
// "@agentic" doesn't match).
const AGENT_MENTION_RE = /@agent\b/i

// Server actions are public HTTP endpoints (callable directly, not just from
// the composer) — every input is validated here, never trusted from the
// client. requireMember throws UnauthorizedError for a missing/invalid session.

const CONTENT_MIN = 1
const CONTENT_MAX = 2000

/**
 * Posts a participant's chat message. The durable insert rides the ADR 0007
 * write path (revision bump + room_events row in one transaction); only after
 * that commits do we fire the `message:new` nudge carrying the full message so
 * other tabs can append it without a refetch. The message is also returned so
 * the sender can reconcile its optimistic copy (dedup by id).
 */
export async function sendMessage(
  sessionToken: string,
  roomId: string,
  content: string
): Promise<ChatMessage> {
  const { participant } = await requireMember(sessionToken, roomId)

  if (typeof content !== "string") {
    throw new Error("Message content is required.")
  }
  const trimmed = content.trim()
  if (trimmed.length < CONTENT_MIN || trimmed.length > CONTENT_MAX) {
    throw new Error(
      `Message must be between ${CONTENT_MIN} and ${CONTENT_MAX} characters.`
    )
  }

  const { result: inserted } = await withRoomRevision({
    roomId,
    eventType: "message_sent",
    actorParticipantId: participant.id,
    payload: { participantId: participant.id },
    write: async (tx) => {
      const [row] = await tx
        .insert(messages)
        .values({
          roomId,
          participantId: participant.id,
          role: "user",
          content: trimmed,
        })
        .returning({ id: messages.id, createdAt: messages.createdAt })
      if (!row) {
        throw new Error("sendMessage: failed to insert message")
      }
      return row
    },
  })
  if (!inserted) {
    throw new Error("sendMessage: failed to insert message")
  }

  const message: ChatMessage = {
    id: inserted.id,
    roomId,
    participantId: participant.id,
    role: "user",
    content: trimmed,
    createdAt: inserted.createdAt.toISOString(),
    author: { name: participant.displayName, color: participant.color },
    reactions: [],
  }

  // Nudge every tab to append the new message (ADR 0012). Fired after commit
  // and best-effort — a realtime hiccup must not fail the durable write.
  try {
    await broadcastRoomEvent(roomId, { type: "message:new", message })
  } catch (err) {
    console.warn("sendMessage: broadcast message:new failed", err)
  }

  // An @agent mention kicks off the same analysis as the header button
  // (shared startAnalysis helper). This runs AFTER the message is durably
  // committed + broadcast, and is entirely best-effort: a trigger failure
  // (e.g. missing TRIGGER_SECRET_KEY) must never fail the user's message
  // send. If the origins guard fails, we post an inline system message
  // prompting for start points instead of silently doing nothing.
  if (AGENT_MENTION_RE.test(trimmed)) {
    try {
      await startAnalysis({
        roomId,
        participantId: participant.id,
        triggerMessageId: inserted.id,
      })
    } catch (err) {
      if (err instanceof NeedsOriginsError) {
        try {
          await postSystemMessage(
            roomId,
            "Set at least two start points on the map first."
          )
        } catch (postErr) {
          console.warn("sendMessage: postSystemMessage failed", postErr)
        }
      } else {
        console.warn("sendMessage: startAnalysis (@agent) failed", err)
      }
    }
  }

  return message
}

export type ToggleReactionResult = { action: "added" | "removed" }

/**
 * Toggles the caller's reaction with `emoji` on `messageId`. Adding and
 * removing are both durable writes (ADR 0007): the existence check and the
 * insert/delete run inside withRoomRevision's transaction, which row-locks the
 * room and so serialises concurrent reaction writers. A `reaction:update`
 * nudge is broadcast after commit so other tabs patch the chip in place.
 */
export async function toggleReaction(
  sessionToken: string,
  roomId: string,
  messageId: string,
  emoji: string
): Promise<ToggleReactionResult> {
  const { participant } = await requireMember(sessionToken, roomId)

  if (!isReactionEmoji(emoji)) {
    throw new Error("Unsupported reaction.")
  }

  const db = getDb()

  // The message must exist AND belong to this room, or a member of room A
  // could react to room B's messages.
  const [message] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.roomId, roomId)))
    .limit(1)
  if (!message) {
    throw new Error("toggleReaction: message not found in room.")
  }

  // Pre-check to pick add vs remove (and thus the event type). The
  // authoritative act happens inside the row-locked transaction below; for a
  // single user toggling one emoji this pre-check cannot realistically race.
  const [existing] = await db
    .select({ emoji: messageReactions.emoji })
    .from(messageReactions)
    .where(
      and(
        eq(messageReactions.messageId, messageId),
        eq(messageReactions.participantId, participant.id),
        eq(messageReactions.emoji, emoji)
      )
    )
    .limit(1)
  const action: "added" | "removed" = existing ? "removed" : "added"

  await withRoomRevision({
    roomId,
    eventType: action === "removed" ? "reaction_removed" : "reaction_added",
    actorParticipantId: participant.id,
    payload: { messageId, participantId: participant.id, emoji },
    write: async (tx) => {
      if (action === "removed") {
        await tx
          .delete(messageReactions)
          .where(
            and(
              eq(messageReactions.messageId, messageId),
              eq(messageReactions.participantId, participant.id),
              eq(messageReactions.emoji, emoji)
            )
          )
      } else {
        await tx
          .insert(messageReactions)
          .values({ messageId, participantId: participant.id, emoji })
          .onConflictDoNothing()
      }
    },
  })

  // Nudge other tabs to patch the reaction chip (ADR 0012). Best-effort.
  try {
    await broadcastRoomEvent(roomId, {
      type: "reaction:update",
      messageId,
      participantId: participant.id,
      emoji,
      action,
    })
  } catch (err) {
    console.warn("toggleReaction: broadcast reaction:update failed", err)
  }

  return { action }
}
