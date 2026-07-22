import { z } from "zod"

// ---------------------------------------------------------------------------
// Shared zod payload/output shapes for the ClickHouse analysis funnel
// (ADR 0008). H3 cells are decimal strings on every JS boundary — never JS
// numbers (precision loss above 2^53).
// ---------------------------------------------------------------------------

/** A participant's start point, enriched with display name + colour. */
export const analysisOrigin = z.object({
  participantId: z.uuid(),
  name: z.string(),
  color: z.string(),
  lat: z.number(),
  lng: z.number(),
  /** TfL journey-planner mode ids (whitelisted in travel.ts). Absent → defaults. */
  transportModes: z.array(z.string()).optional(),
  /** Route step-free when set (accessibilityPreference on the TfL call). */
  requiresStepFree: z.boolean().optional(),
})
export type AnalysisOrigin = z.infer<typeof analysisOrigin>

/** A candidate meeting area (H3 res-8 cell) with its centroid + venue count. */
export const candidate = z.object({
  h3: z.string(),
  lat: z.number(),
  lng: z.number(),
  name: z.string(),
  venueDensity: z.number(),
})
export type Candidate = z.infer<typeof candidate>

// ---------------------------------------------------------------------------
// PlanResult — the denormalised shape the web results card renders. DUPLICATED
// here (a package must not import from an app); SOURCE OF TRUTH for field names
// and semantics: apps/web/lib/types.ts (PlanResult / PlanCandidate). Keep the
// two in sync — the web card reads these keys verbatim.
// ---------------------------------------------------------------------------

// Door-to-door TfL journey (G-phase). Split out as reusable sub-schemas so
// journey-details can share the exact shape. Times are London-local ISO;
// pathPoints are [lat, lon]. MIRROR of PlanCandidate.perParticipant[].journey
// in apps/web/lib/types.ts — keep the two in sync.
export const planJourneyLeg = z.object({
  mode: z.string(),
  lineName: z.string().optional(),
  instruction: z.string(),
  departureTime: z.string(),
  arrivalTime: z.string(),
  durationMinutes: z.number().optional(),
  isDisrupted: z.boolean(),
  pathPoints: z.array(z.tuple([z.number(), z.number()])).optional(),
})
export type PlanJourneyLeg = z.infer<typeof planJourneyLeg>

export const planJourney = z.object({
  durationMinutes: z.number(),
  startDateTime: z.string(),
  arrivalDateTime: z.string(),
  fareTotalPence: z.number().optional(),
  legs: z.array(planJourneyLeg),
})
export type PlanJourney = z.infer<typeof planJourney>

export const planCandidate = z.object({
  h3: z.string(),
  name: z.string(),
  rank: z.number(),
  overallScore: z.number(),
  fairnessScore: z.number(),
  avgMinutes: z.number(),
  maxMinutes: z.number(),
  perParticipant: z.array(
    z.object({
      participantId: z.string(),
      name: z.string(),
      color: z.string(),
      minutes: z.number(),
      // Optional so pre-existing snapshots parse.
      journey: planJourney.optional(),
    })
  ),
  venues: z.array(
    z.object({
      name: z.string(),
      lat: z.number(),
      lng: z.number(),
      category: z.string().optional(),
      fsqPlaceId: z.string().optional(),
      // Google Places liveness fields (ADR 0020). All optional so pre-F plan
      // snapshots parse — mirror of Venue in get-venues.ts and PlanCandidate in
      // apps/web/lib/types.ts.
      googlePlaceId: z.string().optional(),
      verified: z.boolean().optional(),
      source: z.enum(["foursquare", "google"]).optional(),
      rating: z.number().optional(),
      userRatingCount: z.number().optional(),
    })
  ),
})
export type PlanCandidate = z.infer<typeof planCandidate>

export const planResult = z.object({
  candidates: z.array(planCandidate),
})
export type PlanResult = z.infer<typeof planResult>
