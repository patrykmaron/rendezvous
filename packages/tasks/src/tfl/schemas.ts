import { z } from "zod"

// ---------------------------------------------------------------------------
// Task payloads
// ---------------------------------------------------------------------------

/**
 * `from`/`to`/`via` accept WGS84 "lat,long" coordinates, a Naptan/ICS
 * StopPoint id, or a UK postcode. Free text also works but returns
 * `kind: "disambiguation"` instead of journeys (TfL HTTP 300).
 */
export const journeyPlanPayload = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  via: z.string().optional(),
  /** Include stops outside London. */
  nationalSearch: z.boolean().optional(),
  /** yyyyMMdd */
  date: z
    .string()
    .regex(/^\d{8}$/)
    .optional(),
  /** HHmm */
  time: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
  timeIs: z.enum(["Arriving", "Departing"]).optional(),
  journeyPreference: z
    .enum(["LeastInterchange", "LeastTime", "LeastWalking"])
    .optional(),
  /**
   * Deliberately not an enum: live mode ids differ from TfL's OpenAPI doc
   * (e.g. "bus" not "public-bus", "national-rail" not "train", "cable-car").
   * Run the tfl-journey-modes task for the live list.
   */
  mode: z.array(z.string()).optional(),
  /** Comma-separated list, e.g. "noSolidStairs,stepFreeToVehicle". */
  accessibilityPreference: z.string().optional(),
  walkingSpeed: z.enum(["Slow", "Average", "Fast"]).optional(),
  cyclePreference: z
    .enum([
      "None",
      "LeaveAtStation",
      "TakeOnTransport",
      "AllTheWay",
      "CycleHire",
    ])
    .optional(),
  bikeProficiency: z.enum(["Easy", "Moderate", "Fast"]).optional(),
  maxWalkingMinutes: z.number().int().positive().optional(),
  /** One call returns public transport + bus + cycle-hire + cycle + walking. */
  useMultiModalCall: z.boolean().optional(),
})

export const journeyModesPayload = z.object({})

export const bikePointsListPayload = z.object({})

/** Full TfL id, e.g. "BikePoints_583" — unknown ids come back not_found. */
export const bikePointGetPayload = z.object({ id: z.string().min(1) })

export const bikePointSearchPayload = z.object({ query: z.string().min(1) })

// ---------------------------------------------------------------------------
// Raw TfL response extraction — only the fields the mappers read; z.object
// strips everything else on parse, which is the compaction we want. Every
// field is optional: TfL response schemas are undocumented in places.
// ---------------------------------------------------------------------------

const rawPoint = z.object({
  lat: z.number().optional(),
  lon: z.number().optional(),
})

export const rawItineraryResult = z.object({
  journeys: z
    .array(
      z.object({
        startDateTime: z.string().optional(),
        arrivalDateTime: z.string().optional(),
        /** Minutes. */
        duration: z.number().optional(),
        /** totalCost is pence. */
        fare: z.object({ totalCost: z.number().optional() }).optional(),
        legs: z
          .array(
            z.object({
              mode: z
                .object({
                  id: z.string().optional(),
                  name: z.string().optional(),
                })
                .optional(),
              instruction: z
                .object({
                  summary: z.string().optional(),
                  detailed: z.string().optional(),
                })
                .optional(),
              departureTime: z.string().optional(),
              arrivalTime: z.string().optional(),
              departurePoint: rawPoint.optional(),
              arrivalPoint: rawPoint.optional(),
              /** Metres. */
              distance: z.number().optional(),
              isDisrupted: z.boolean().optional(),
            })
          )
          .optional(),
      })
    )
    .optional(),
})

// Shape verified live (HTTP 300 DisambiguationResult): each section has
// matchStatus — observed values "list" (options to pick from), "identified"
// (resolved, no options needed), "empty" / "notidentified" (no match) — and
// up to 20 options sorted best-first by matchQuality.
export const rawDisambiguationSection = z.object({
  matchStatus: z.string().optional(),
  disambiguationOptions: z
    .array(
      z.object({
        /** ICS code TfL accepts back as from/to/via on a re-trigger. */
        parameterValue: z.string().optional(),
        matchQuality: z.number().optional(),
        place: z
          .object({
            commonName: z.string().optional(),
            lat: z.number().optional(),
            lon: z.number().optional(),
          })
          .optional(),
      })
    )
    .optional(),
})

export const rawDisambiguationResult = z.object({
  fromLocationDisambiguation: rawDisambiguationSection.optional(),
  toLocationDisambiguation: rawDisambiguationSection.optional(),
  viaLocationDisambiguation: rawDisambiguationSection.optional(),
})

/** Tfl.Api.Presentation.Entities.ApiError */
export const rawApiError = z.object({
  message: z.string().optional(),
  exceptionType: z.string().optional(),
})

export const rawPlace = z.object({
  id: z.string().optional(),
  commonName: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  additionalProperties: z
    .array(
      z.object({
        key: z.string().optional(),
        value: z.string().nullable().optional(),
      })
    )
    .optional(),
})

export const rawMode = z.object({
  modeName: z.string().optional(),
  isTflService: z.boolean().optional(),
  isFarePaying: z.boolean().optional(),
  isScheduledService: z.boolean().optional(),
})

// ---------------------------------------------------------------------------
// Simplified outputs — the contract parent agent tasks consume via
// triggerAndWait. Keep these compact: raw TfL journey responses run to
// hundreds of KB.
// ---------------------------------------------------------------------------

export type LatLon = { lat: number; lon: number }

export type JourneyLeg = {
  mode: string
  instruction: string
  departureTime: string
  arrivalTime: string
  departurePoint: LatLon
  arrivalPoint: LatLon
  distanceMetres?: number
  isDisrupted: boolean
}

export type JourneyOption = {
  startDateTime: string
  arrivalDateTime: string
  durationMinutes: number
  legs: JourneyLeg[]
  fareTotalPence?: number
}

export type DisambiguationOption = {
  /** Re-trigger tfl-journey-plan with this as from/to/via to resolve. */
  parameterValue: string
  commonName?: string
  lat?: number
  lon?: number
  matchQuality?: number
}

/**
 * matchStatus "list" → pick an option and re-trigger; "identified" (or the
 * section absent) → keep the original value; "empty" / "notidentified" → that
 * location is unresolvable, don't re-trigger with it.
 */
export type DisambiguationSection = {
  matchStatus: string
  options: DisambiguationOption[]
}

export type PlanJourneyOutput =
  | { kind: "journeys"; journeys: JourneyOption[] }
  | {
      kind: "disambiguation"
      from?: DisambiguationSection
      to?: DisambiguationSection
      via?: DisambiguationSection
    }
  // Deterministic TfL 404: unresolvable location or no route. A semantic
  // outcome, not a retryable failure.
  | { kind: "no_journeys"; message: string }

export type BikePointStatus = {
  id: string
  commonName: string
  lat: number
  lon: number
  nbBikes: number
  nbEmptyDocks: number
  nbDocks: number
  /** Out-of-service docks are excluded from the nb* counts, so the gap is broken docks. */
  brokenDocks: number
  installed: boolean
  locked: boolean
  standardBikes?: number
  eBikes?: number
}

/** /BikePoint/Search omits occupancy — chain into tfl-bikepoint-get for live status. */
export type BikePointSearchHit = {
  id: string
  commonName: string
  lat: number
  lon: number
}

export type TransportMode = {
  modeName: string
  isTflService: boolean
  isFarePaying: boolean
  isScheduledService: boolean
}
