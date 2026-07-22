import { bearerToken, requireMember, UnauthorizedError } from "@/lib/auth"
import type { PlacePreview, PlacePreviewResponse } from "@/lib/place-preview"
import { UUID_RE } from "@/lib/validate"

// Server-proxied Google Places (New) preview for a venue pin / plan-card chip
// (ADR 0018). Auth mirrors the plan route: bearer sessionToken + membership
// proof. `GOOGLE_PLACES_KEY` is server-only — never sent to the browser — and
// the route degrades to `{ ok: false, reason: "unavailable" }` when it's
// unset, so previews are optional infrastructure, not a hard dependency.
//
// Billing: rating/price/hours fields put the Text Search call in the
// Enterprise SKU, and the photo media call bills separately (~$7/1k). Never
// call Google in a loop and never prefetch — only on an explicit user click,
// and only after an in-process cache miss (see `cache` below).

const PLACES_FIELD_MASK =
  "places.id, places.displayName, places.location, places.rating, places.userRatingCount, places.priceLevel, places.formattedAddress, places.googleMapsUri, places.regularOpeningHours.openNow, places.photos"

const NAME_MAX = 200
// Text Search's locationBias is a *bias*, not a hard filter — the mismatch
// guard below (haversine vs. this radius) is what actually keeps a same-named
// venue on the other side of London from being shown.
const LOCATION_BIAS_RADIUS_M = 250
// A result further than this from the query point is treated as the wrong
// place, never the right one with noisy geocoding — false negatives (no
// photo) are far cheaper than false positives (someone else's venue photo).
const MISMATCH_THRESHOLD_M = 500

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
// Google outages/hiccups get a short-lived cache entry instead of the full
// 24h — a transient `unavailable` shouldn't poison every click on a venue for
// a full day, but repeated clicks during the outage still shouldn't hammer
// Google every time.
const UNAVAILABLE_TTL_MS = 5 * 60 * 1000
const CACHE_CAP = 500

type CacheEntry = { value: PlacePreviewResponse; expires: number }

// Module-scope, in-process, single-instance cache (documented upgrade path:
// ADR 0018 notes a Postgres-backed cache for multi-instance deployments).
// Insertion order == Map iteration order, so eviction below is a plain FIFO
// (oldest key first) without a separate queue.
const cache = new Map<string, CacheEntry>()

function cacheGet(key: string): PlacePreviewResponse | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (entry.expires <= Date.now()) {
    cache.delete(key)
    return undefined
  }
  return entry.value
}

function cacheSet(
  key: string,
  value: PlacePreviewResponse,
  ttlMs: number
): void {
  if (!cache.has(key) && cache.size >= CACHE_CAP) {
    const oldestKey = cache.keys().next().value
    if (oldestKey !== undefined) cache.delete(oldestKey)
  }
  cache.set(key, { value, expires: Date.now() + ttlMs })
}

const PRICE_LEVELS: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
}

function mapPriceLevel(level: unknown): number | null {
  if (typeof level !== "string") return null
  return PRICE_LEVELS[level] ?? null
}

// Great-circle distance in metres — the mismatch guard between the query
// point and whatever Text Search actually returned.
function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const EARTH_RADIUS_M = 6371000
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const sinLat = Math.sin(dLat / 2)
  const sinLng = Math.sin(dLng / 2)
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))
}

// Loose shape for Text Search's response — only the fields the field mask
// above actually requests.
type GooglePlace = {
  displayName?: { text?: string }
  location?: { latitude?: number; longitude?: number }
  rating?: number
  userRatingCount?: number
  priceLevel?: string
  formattedAddress?: string
  googleMapsUri?: string
  regularOpeningHours?: { openNow?: boolean }
  photos?: Array<{ name?: string }>
}
type GoogleSearchTextResponse = { places?: GooglePlace[] }
type GooglePhotoMediaResponse = { photoUri?: string }

async function fetchPhotoUrl(
  apiKey: string,
  photoName: string | undefined
): Promise<string | null> {
  if (!photoName) return null
  try {
    const res = await fetch(
      `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=500&maxWidthPx=800&skipHttpRedirect=true&key=${apiKey}`
    )
    if (!res.ok) return null
    const data = (await res.json()) as GooglePhotoMediaResponse
    return data.photoUri ?? null
  } catch {
    // Non-fatal: the card just shows no photo.
    return null
  }
}

/** Runs the single Text Search call + optional photo fetch. Never throws. */
async function fetchPreview(
  apiKey: string,
  query: { name: string; lat: number; lng: number }
): Promise<{ response: PlacePreviewResponse; ttlMs: number }> {
  let searchRes: Response
  try {
    searchRes = await fetch(
      "https://places.googleapis.com/v1/places:searchText",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": PLACES_FIELD_MASK,
        },
        body: JSON.stringify({
          textQuery: query.name,
          pageSize: 1,
          locationBias: {
            circle: {
              center: { latitude: query.lat, longitude: query.lng },
              radius: LOCATION_BIAS_RADIUS_M,
            },
          },
        }),
      }
    )
  } catch (err) {
    console.warn("places-preview: search request failed", err)
    return {
      response: { ok: false, reason: "unavailable" },
      ttlMs: UNAVAILABLE_TTL_MS,
    }
  }

  if (!searchRes.ok) {
    console.warn("places-preview: search returned", searchRes.status)
    return {
      response: { ok: false, reason: "unavailable" },
      ttlMs: UNAVAILABLE_TTL_MS,
    }
  }

  const data = (await searchRes.json()) as GoogleSearchTextResponse
  const place = data.places?.[0]
  if (
    !place ||
    typeof place.location?.latitude !== "number" ||
    typeof place.location?.longitude !== "number"
  ) {
    return { response: { ok: false, reason: "not_found" }, ttlMs: CACHE_TTL_MS }
  }

  // Never show the wrong venue's photo/rating — a same-named place elsewhere
  // in London is worse than no preview at all.
  const distance = haversineMeters(query, {
    lat: place.location.latitude,
    lng: place.location.longitude,
  })
  if (distance > MISMATCH_THRESHOLD_M) {
    return { response: { ok: false, reason: "not_found" }, ttlMs: CACHE_TTL_MS }
  }

  const photoUrl = await fetchPhotoUrl(apiKey, place.photos?.[0]?.name)

  const preview: PlacePreview = {
    name: place.displayName?.text ?? query.name,
    rating: typeof place.rating === "number" ? place.rating : null,
    userRatingCount:
      typeof place.userRatingCount === "number" ? place.userRatingCount : null,
    priceLevel: mapPriceLevel(place.priceLevel),
    address: place.formattedAddress ?? null,
    openNow:
      typeof place.regularOpeningHours?.openNow === "boolean"
        ? place.regularOpeningHours.openNow
        : null,
    photoUrl,
    googleMapsUri: place.googleMapsUri ?? null,
  }

  return { response: { ok: true, place: preview }, ttlMs: CACHE_TTL_MS }
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const roomId = url.searchParams.get("roomId") ?? ""
  const name = url.searchParams.get("name") ?? ""
  const lat = Number(url.searchParams.get("lat"))
  const lng = Number(url.searchParams.get("lng"))
  const fsq = url.searchParams.get("fsq") || undefined

  if (
    !UUID_RE.test(roomId) ||
    name.length === 0 ||
    name.length > NAME_MAX ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return new Response("Bad Request", { status: 400 })
  }

  try {
    await requireMember(bearerToken(request), roomId)
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return new Response("Unauthorized", { status: 401 })
    }
    throw err
  }

  const apiKey = process.env.GOOGLE_PLACES_KEY
  if (!apiKey) {
    return Response.json({
      ok: false,
      reason: "unavailable",
    } satisfies PlacePreviewResponse)
  }

  const key = fsq
    ? `fsq:${fsq}`
    : `geo:${name.toLowerCase()}|${lat.toFixed(4)}|${lng.toFixed(4)}`

  const cached = cacheGet(key)
  if (cached) {
    return Response.json(cached)
  }
  console.log("places-preview miss", key)

  const { response, ttlMs } = await fetchPreview(apiKey, { name, lat, lng })
  cacheSet(key, response, ttlMs)
  return Response.json(response)
}
