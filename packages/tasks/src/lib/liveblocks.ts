import { Liveblocks } from "@liveblocks/node"

// Task-side broadcaster for ephemeral room nudges (ADR 0012). A package must
// not import from an app, so this duplicates the minimal slice of the
// RoomEvent union that tasks actually emit. SOURCE OF TRUTH for the full union
// and its semantics: apps/web/liveblocks.config.ts — keep this subset in sync.
export type TaskRoomEvent =
  | { type: "plan:updated"; analysisId: string }
  | { type: "agent:started"; runId: string }
  | {
      // Mirrors the web RoomEvent's `constraint:update` variant (its
      // `constraint` is a ConstraintView). `kind` is a plain string here —
      // the app narrows it to its ConstraintKind union on receipt.
      type: "constraint:update"
      action: "added" | "removed"
      constraint: {
        id: string
        roomId: string
        participantId: string | null
        kind: string
        isHard: boolean
        summary: string
        createdAt: string
        author?: { name: string; color: string }
      }
    }
  | {
      type: "message:new"
      message: {
        id: string
        roomId: string
        participantId: string | null
        role: "user" | "assistant" | "system"
        content: string
        createdAt: string
        author?: { name: string; color: string }
        // Chat clients read `message.reactions` unconditionally; a broadcast
        // that omits it crashes their render. New messages carry an empty
        // array. Mirrors MessageReactionSummary[] in apps/web/lib/types.ts.
        reactions: {
          emoji: string
          count: number
          reactedByMe: boolean
          names: string[]
        }[]
      }
    }

let client: Liveblocks | null = null

function getLiveblocks(): Liveblocks {
  if (!client) {
    client = new Liveblocks({ secret: process.env.LIVEBLOCKS_SECRET_KEY! })
  }
  return client
}

export async function broadcastRoomEvent(
  roomId: string,
  event: TaskRoomEvent
): Promise<void> {
  await getLiveblocks().broadcastEvent(`room:${roomId}`, event)
}
