import type {
  ChatMessage,
  ConstraintView,
  ReactionUpdate,
  RoomDecision,
} from "@/lib/types"

// Single source of truth for Liveblocks' per-room typing. Per ADR 0012,
// Liveblocks carries ONLY ephemeral, presence-shaped state plus small
// "something changed, go refetch" nudges — never durable data (that lives in
// Postgres). The `declare global` block below types every hook in
// @liveblocks/react and every broadcast from @liveblocks/node across the app.

// Live cursor position, tagged by which surface it's on. `map` is a shared
// geographic space (lng/lat). The other surfaces normalise to 0..1 against
// that surface's own bounding rect, so a chat cursor always renders inside
// the recipient's chat panel regardless of window size — null when off any
// tracked surface.
export type CursorPresence =
  | { surface: "map"; lng: number; lat: number }
  | { surface: "chat"; x: number; y: number }
  | { surface: "header"; x: number; y: number }
  | null

// What each connected client continuously publishes about itself.
export type RoomPresence = {
  cursor: CursorPresence
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
  | {
      type: "constraint:update"
      action: "added" | "removed"
      constraint: ConstraintView
    }
  // The room's target meeting time changed (G-phase event-time). null clears it.
  | { type: "settings:update"; eventAt: string | null }
  // A vote was toggled. `voterIds` is the FULL post-change tally for the
  // candidate — receivers replace that candidate's list, never increment.
  | {
      type: "vote:update"
      snapshotId: string
      candidateH3: string
      voterIds: string[]
      action: "added" | "removed"
      participantId: string
    }
  // The host locked in (or cleared, on a re-plan) a decision.
  | { type: "decided:update"; decision: RoomDecision | null }

declare global {
  interface Liveblocks {
    Presence: RoomPresence
    UserMeta: RoomUserMeta
    RoomEvent: RoomEvent
  }
}
