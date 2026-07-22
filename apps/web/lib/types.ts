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
  // Travel preferences (G-phase). Optional so the `origin:update` broadcast
  // shape is untouched — these only ride the authenticated origins fetch and
  // feed routing, not pin rendering. `transportModes` are raw TfL mode ids
  // (see apps/web/lib/travel.ts).
  transportModes?: string[]
  requiresStepFree?: boolean
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
    // Google Places id (venue pins only) — lets the preview route fetch the
    // place directly (exact, cheaper) instead of Text Search (ADR 0020).
    googlePlaceId?: string
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
  // Google Places id — when present the preview route GETs the place directly
  // (exact match, cheaper than Text Search; ADR 0020).
  googlePlaceId?: string
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
    // Door-to-door TfL journey for this participant to the area (G-phase).
    // Optional so pre-existing snapshots parse; mirror of the `journey` object
    // in the planCandidate zod schema (packages/tasks/src/trigger/analysis/
    // types.ts). Times are London-local ISO; `pathPoints` are [lat, lon].
    journey?: {
      durationMinutes: number
      startDateTime: string // London-local ISO — "leave by" source
      arrivalDateTime: string
      fareTotalPence?: number
      legs: Array<{
        mode: string
        lineName?: string
        instruction: string
        departureTime: string
        arrivalTime: string
        durationMinutes?: number
        isDisrupted: boolean
        pathPoints?: [number, number][] // [lat, lon]
      }>
    }
  }>
  venues: Array<{
    name: string
    lat: number
    lng: number
    category?: string
    fsqPlaceId?: string
    // Google Places liveness fields (ADR 0020). All optional so pre-F plan
    // snapshots parse — mirror of Venue (get-venues.ts) + the planCandidate zod
    // schema (packages/tasks/src/trigger/analysis/types.ts).
    googlePlaceId?: string
    verified?: boolean
    source?: "foursquare" | "google"
    rating?: number
    userRatingCount?: number
  }>
}

export type PlanResult = {
  candidates: PlanCandidate[]
}

// One candidate area's approval tally. `voterIds` are participant ids —
// colours/names resolve client-side from the members map. Broadcast live via
// `vote:update` (receivers replace the whole list, never increment).
export type VoteTally = {
  candidateH3: string
  voterIds: string[]
}

// The host's locked-in decision, denormalised into rooms.settings.decided
// (mirror the shape in RoomSettings, packages/db/src/postgres/schema.ts).
export type RoomDecision = {
  snapshotId: string
  candidateH3: string
  candidateName: string
  decidedBy: { participantId: string; name: string }
  decidedAt: string // ISO-8601
}

// One plan snapshot, as embedded in PlanResponse. `id` is the vote key
// (plan_snapshots.id); a running/pending/failed status is possible (the first
// run before any complete plan exists), which the card decides how to show.
export type PlanSnapshotView = {
  id: string // plan_snapshots.id — the vote key
  status: "pending" | "running" | "complete" | "failed"
  analysisId: string
  result: PlanResult | null
  createdAt: string
}

// GET /api/rooms/[id]/plan — always 200. `plan` is the newest COMPLETE
// snapshot (newest-overall only when none was ever complete), so a re-plan in
// flight keeps the previous plan on screen instead of blanking it. `replanning`
// / `updateFailed` describe the newest-overall snapshot relative to `plan`.
export type PlanResponse = {
  // Newest COMPLETE snapshot; newest-overall only if none complete ever; null
  // when the room has never been analysed (the empty state).
  plan: PlanSnapshotView | null
  // Newest-overall snapshot is running/pending — a re-plan is in flight.
  replanning: boolean
  // Newest-overall snapshot failed while a complete plan is still shown.
  updateFailed: boolean
  // Approval tallies for plan.id; [] when plan is null.
  votes: VoteTally[]
  // candidateH3s the caller has approved on plan.id.
  myVotes: string[]
  // The host's locked-in decision, or null when the room isn't decided.
  decision: RoomDecision | null
}
