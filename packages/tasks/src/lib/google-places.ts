// Minimal server-side wrappers over Google Places API (New) for the analysis
// funnel's venue LIVENESS pass (ADR 0020). No SDK dependency — plain fetch.
//
// The ClickHouse Foursquare serving table is a Nov-2024 snapshot, so some of the
// venues it returns are closed or gone by the time a plan is built. `ch-get-
// venues` uses these helpers to (a) validate each Foursquare venue against
// Google's live index and drop the ones Google reports non-OPERATIONAL or can't
// resolve, and (b) backfill thin cells from a Google Text Search.
//
// The key (`GOOGLE_PLACES_KEY`) is read here and never leaves the server/task
// runtime. When it's unset `searchText` returns null (same as any failure) so
// the caller degrades to unvalidated pass-through — validation is optional
// infrastructure, never a hard dependency. Every call is single-attempt with a
// 10s timeout; the caller never loops or retries (a failed validation must keep
// the venue, not empty the plan).

/** Text Search endpoint (POST). */
export const PLACES_SEARCH_ENDPOINT =
  "https://places.googleapis.com/v1/places:searchText"

/** Place Details endpoint base (GET `${PLACES_DETAILS_ENDPOINT}/{placeId}`). */
export const PLACES_DETAILS_ENDPOINT = "https://places.googleapis.com/v1/places"

// The only fields this phase needs from a Text Search result: id (to thread to
// the preview flow for an exact, cheaper lookup), display name + location (for
// the venue record / mismatch guard), businessStatus (the liveness signal), and
// rating/userRatingCount (surfaced to the model + card).
export const SEARCH_FIELD_MASK =
  "places.id,places.displayName,places.location,places.businessStatus,places.rating,places.userRatingCount"

// A single Google Places result, loosely typed to the fields SEARCH_FIELD_MASK
// requests (all optional — Google omits fields it has no data for).
export type GooglePlace = {
  id?: string
  displayName?: { text?: string }
  location?: { latitude?: number; longitude?: number }
  businessStatus?: string
  rating?: number
  userRatingCount?: number
}

type SearchTextResponse = { places?: GooglePlace[] }

const CALL_TIMEOUT_MS = 10_000

/**
 * One Google Places (New) Text Search. Returns the parsed places array on a 2xx
 * (an empty array when Google found nothing), or `null` on ANY failure — no key,
 * network error, timeout, non-2xx, or non-JSON body. The distinction matters to
 * the caller: `[]` is a definitive "no such place" (drop the venue), whereas
 * `null` is "couldn't check" (keep the venue unverified). Single attempt, never
 * retried.
 */
export async function searchText(args: {
  query: string
  lat: number
  lng: number
  radius: number
  fieldMask?: string
  pageSize?: number
}): Promise<GooglePlace[] | null> {
  const apiKey = process.env.GOOGLE_PLACES_KEY
  if (!apiKey) return null

  try {
    const res = await fetch(PLACES_SEARCH_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": args.fieldMask ?? SEARCH_FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: args.query,
        pageSize: args.pageSize ?? 1,
        locationBias: {
          circle: {
            center: { latitude: args.lat, longitude: args.lng },
            radius: args.radius,
          },
        },
      }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const data = (await res.json()) as SearchTextResponse
    return data.places ?? []
  } catch {
    // Network error, timeout (AbortError), or non-JSON body — the caller treats
    // a null as "unverified, keep" so an availability blip never empties a plan.
    return null
  }
}

/** Great-circle distance in metres between two lat/lng points. */
export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const EARTH_RADIUS_M = 6371000
  const toRad = (deg: number): number => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const sinLat = Math.sin(dLat / 2)
  const sinLng = Math.sin(dLng / 2)
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))
}
