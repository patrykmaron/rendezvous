import type { ChatMessage, ReactionUpdate } from "@/lib/types"

// Single source of truth for Liveblocks' per-room typing. Per ADR 0012,
// Liveblocks carries ONLY ephemeral, presence-shaped state plus small
// "something changed, go refetch" nudges — never durable data (that lives in
// Postgres). The `declare global` block below types every hook in
// @liveblocks/react and every broadcast from @liveblocks/node across the app.

// What each connected client continuously publishes about itself.
export type RoomPresence = {
  // Live cursor on the map, or null when off-canvas.
  cursor: { lng: number; lat: number } | null
  isTyping: boolean
  // Mirrors the participant's authoritative colour so others can recolour
  // instantly on a change without waiting for a refetch.
  color: string
}

// Static per-user metadata, resolved once at auth time (see
// app/api/liveblocks-auth/route.ts) and exposed via `user.info`.
export type RoomUserMeta = {
  id: string
  info: { name: string; color: string }
}

// Broadcast events. Discriminated on `type`. Every variant is a "nudge":
// receivers refetch authoritative state from Postgres rather than trusting the
// payload as durable truth.
export type RoomEvent =
  | { type: "message:new"; message: ChatMessage }
  | ({ type: "reaction:update" } & ReactionUpdate)
  | {
      type: "origin:update"
      participantId: string
      lat: number
      lng: number
      label?: string
    }
  | {
      type: "member:update"
      kind: "joined" | "color"
      participantId: string
      name: string
      color: string
    }
  | { type: "plan:updated"; analysisId: string }
  | { type: "agent:started"; runId: string }

declare global {
  interface Liveblocks {
    Presence: RoomPresence
    UserMeta: RoomUserMeta
    RoomEvent: RoomEvent
  }
}
