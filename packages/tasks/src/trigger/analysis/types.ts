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
