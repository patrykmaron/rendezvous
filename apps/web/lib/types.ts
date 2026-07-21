// Shared chat/reaction shapes. Kept framework-agnostic (plain serialisable
// types) so they can travel over Liveblocks broadcasts (see
// apps/web/liveblocks.config.ts) and API/JSON boundaries alike.

export type ChatMessage = {
  id: string
  roomId: string
  // null author = assistant/system message
  participantId: string | null
  role: "user" | "assistant" | "system"
  content: string
  // ISO-8601 string (Dates don't survive JSON / the realtime wire).
  createdAt: string
  author?: { name: string; color: string }
}

export type ReactionUpdate = {
  messageId: string
  participantId: string
  emoji: string
  action: "added" | "removed"
}

// A participant's start point on the map. Enriched with the owner's display
// name + colour (joined from `participants`) so a marker can be drawn without a
// second lookup. `label` is an optional human place name ("Home", "Work").
export type OriginPoint = {
  participantId: string
  name: string
  color: string
  lat: number
  lng: number
  label?: string
}

// Everything the agent (Task 9) can paint onto the map on top of the origins.
// The room shell owns this state with empty defaults; Task 9 feeds it from
// analysis metadata. `routes` is a GeoJSON FeatureCollection whose features
// carry a `color` property (read by the line layer), or null when there are no
// routes to draw.
export type MapOverlay = {
  pins: Array<{
    id: string
    lat: number
    lng: number
    kind: "candidate" | "venue"
    rank?: number
    label?: string
    color?: string
  }>
  routes: GeoJSON.FeatureCollection | null
  focus?: { lat: number; lng: number; zoom?: number } | null
}
