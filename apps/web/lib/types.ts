// Shared chat/reaction shapes. Kept framework-agnostic (plain serialisable
// types) so they can travel over Liveblocks broadcasts (see
// apps/web/liveblocks.config.ts) and API/JSON boundaries alike.

// One emoji's worth of reactions on a message, pre-aggregated for rendering:
// how many people reacted, whether I'm one of them, and their display names
// (for the chip tooltip). Assembled server-side by the messages API and
// patched live by `reaction:update` nudges.
export type MessageReactionSummary = {
  emoji: string
  count: number
  reactedByMe: boolean
  names: string[]
}

export type ChatMessage = {
  id: string
  roomId: string
  // null author = assistant/system message
  participantId: string | null
  role: "user" | "assistant" | "system"
  content: string
  // ISO-8601 string (Dates don't survive JSON / the realtime wire).
  createdAt: string
  // assistant/system rows resolve to the "Rendezvous" persona name/colour.
  author?: { name: string; color: string }
  // Aggregated reactions (empty for a brand-new message).
  reactions: MessageReactionSummary[]
}

export type ReactionUpdate = {
  messageId: string
  participantId: string
  emoji: string
  action: "added" | "removed"
}

// The planning-constraint taxonomy the extractor (ADR 0019) classifies chat
// messages into. Kept as a runtime `as const` tuple so both the strict OpenAI
// json_schema enum (mirrored task-side) and the chip icon map can key off it.
export const CONSTRAINT_KINDS = [
  "diet",
  "accessibility",
  "budget",
  "area",
  "time",
  "venue_type",
  "transport",
  "other",
] as const
export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number]

// One planning constraint as rendered in the chat's chip strip. Assembled by
// the constraints API and the extractor's `constraint:update` broadcasts.
// `participantId === null` = a room-wide constraint (no author chip tint).
export type ConstraintView = {
  id: string
  roomId: string
  participantId: string | null // null = room-wide
  kind: ConstraintKind
  isHard: boolean
  summary: string // human chip label, <=40 chars
  createdAt: string // ISO-8601
  author?: { name: string; color: string } // absent for room-wide
}

// Narrows a free-text DB `kind` to the known union, defaulting unknown/legacy
// values to "other" so ConstraintView.kind stays honest for the chip icon map.
export function asConstraintKind(kind: string): ConstraintKind {
  return (CONSTRAINT_KINDS as readonly string[]).includes(kind)
    ? (kind as ConstraintKind)
    : "other"
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
    // Foursquare place id (venue pins only) — enables a Google Places
    // preview card on click (ADR 0018). Optional: old persisted snapshots
    // and model-painted pins predate/omit it.
    placeId?: string
  }>
  routes: GeoJSON.FeatureCollection | null
  focus?: { lat: number; lng: number; zoom?: number } | null
}

// A pin the map/plan-card can request a Google Places preview card for
// (ADR 0018). Deliberately its own type rather than reusing MapOverlay's pin
// shape or PlanCandidate's venue shape — it's the one normalised input both
// the map's venue-pin click and the plan-card's venue-chip click funnel
// into before calling the preview API.
export type PlacePreviewTarget = {
  id: string
  name: string
  lat: number
  lng: number
  category?: string
  fsqPlaceId?: string
}

// The agent's proposed meeting areas, denormalised into plan_snapshots.result
// for instant render (see planSnapshots.result in the DB schema). Produced by
// the analysis in Task 9; consumed read-only by the chat's results card.
export type PlanCandidate = {
  // H3 cell (resolution 8) identifying the area — also the vote key.
  h3: string
  name: string
  rank: number
  overallScore: number
  fairnessScore: number
  avgMinutes: number
  maxMinutes: number
  perParticipant: Array<{
    participantId: string
    name: string
    color: string
    minutes: number
  }>
  venues: Array<{
    name: string
    lat: number
    lng: number
    category?: string
    fsqPlaceId?: string
  }>
}

export type PlanResult = {
  candidates: PlanCandidate[]
}

// The latest plan snapshot for a room, as served by GET /api/rooms/[id]/plan.
export type PlanSnapshotView = {
  status: "pending" | "running" | "complete" | "failed"
  analysisId: string
  result: PlanResult | null
  createdAt: string
}
