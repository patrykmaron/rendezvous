// ---------------------------------------------------------------------------
// Travel-preference helpers shared by the routing pipeline (route-matrix +
// journey-details). Storage convention: participant_origins.transport_modes
// holds raw TfL journey-planner mode ids (ADR 0013 — live ids, not OpenAPI).
// ---------------------------------------------------------------------------

/** Live journey-planner ids we allow through from stored/derived prefs. */
export const TFL_MODE_WHITELIST = new Set([
  "tube",
  "bus",
  "walking",
  "dlr",
  "overground",
  "elizabeth-line",
  "cycle",
  "national-rail",
  "tram",
  "river-bus",
])

/** Default mode set — today's ROUTE_MODES; used when a participant has no
 *  usable prefs so a bad/empty pref can never silently unroute someone. */
export const DEFAULT_MODES = [
  "tube",
  "bus",
  "walking",
  "dlr",
  "overground",
  "elizabeth-line",
]

/** accessibilityPreference value requested when requiresStepFree is set. */
export const STEP_FREE_PREFERENCE = "noSolidStairs,stepFreeToVehicle"

/**
 * Map a participant's stored transportModes to the TfL mode ids to route with.
 * Whitelists the input, falls back to DEFAULT_MODES on empty/garbage, and
 * always appends "walking" (every journey ends on foot).
 */
export function modesFor(origin: { transportModes?: string[] }): string[] {
  const picked = (origin.transportModes ?? []).filter((m) =>
    TFL_MODE_WHITELIST.has(m)
  )
  if (picked.length === 0) return DEFAULT_MODES
  return [...new Set([...picked, "walking"])]
}

/**
 * Split a London wall-clock "yyyy-MM-ddTHH:mm" (datetime-local format, no zone)
 * into TfL journey-planner params { date: "yyyyMMdd", time: "HHmm" }. TfL's
 * date/time are London-local, so no conversion happens. Returns null when the
 * string is malformed or in the past — the caller then applies the
 * next-Saturday fallback rather than sending TfL a stale anchor.
 */
export function tflDateTimeFrom(
  eventAt: string
): { date: string; time: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(eventAt)
  if (!m) return null
  const [, yyyy, mm, dd, hh, min] = m
  // Parse-as-UTC only to reject past times — same approximation
  // nextSaturdayDeparture makes; the returned params stay London-local.
  const t = Date.parse(`${yyyy}-${mm}-${dd}T${hh}:${min}:00Z`)
  if (Number.isNaN(t) || t <= Date.now()) return null
  return { date: `${yyyy}${mm}${dd}`, time: `${hh}${min}` }
}

/**
 * Thin a participant's leg geometry so the TOTAL vertex count across its legs
 * is <= maxTotal, keeping first+last per leg. Used only for the run-metadata
 * map overlay (256KB cap); the plan snapshot keeps full 50-pt/leg geometry.
 */
export function capJourneyPoints<L extends { pathPoints?: [number, number][] }>(
  legs: L[],
  maxTotal: number
): L[] {
  const total = legs.reduce((s, l) => s + (l.pathPoints?.length ?? 0), 0)
  if (total <= maxTotal) return legs
  const ratio = maxTotal / total
  return legs.map((l) => {
    const pts = l.pathPoints
    if (!pts || pts.length <= 2) return l
    const target = Math.max(2, Math.round(pts.length * ratio))
    if (target >= pts.length) return l
    const stride = (pts.length - 1) / (target - 1)
    const out: [number, number][] = []
    for (let i = 0; i < target; i++) out.push(pts[Math.round(i * stride)]!)
    out[out.length - 1] = pts[pts.length - 1]! // guarantee the last point
    return { ...l, pathPoints: out }
  })
}
