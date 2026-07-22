import { chQuery } from "@workspace/db/clickhouse/query"
import { logger, schemaTask } from "@trigger.dev/sdk"
import { z } from "zod"

import { haversineMeters, searchText } from "../../lib/google-places"

const getVenuesPayload = z.object({
  h3Cells: z.array(z.string()).min(1).max(3),
  categories: z.array(z.string()).optional(),
})

export type Venue = {
  h3: string
  // Foursquare place id. Optional because Google-backfilled venues (ADR 0020)
  // have none — they carry a googlePlaceId instead.
  fsqPlaceId?: string
  name: string
  lat: number
  lng: number
  // Foursquare primary category. Optional because backfilled venues don't have
  // one (the Google field mask omits type to stay on the cheap SKU).
  category?: string
  address?: string
  // True when this venue matched the model's category keywords (so the agent
  // can honestly say the preference was met). Absent when no keywords were
  // passed (nothing to match against).
  matched?: boolean
  // --- Phase F (ADR 0020): Google Places liveness. All optional so pre-F plan
  // snapshots still parse. ---
  // Set true only when Google confirmed the venue OPERATIONAL near its coords
  // (or it came straight from a Google backfill search). Left undefined when a
  // validation call failed (kept, but unproven) or Google is unconfigured.
  verified?: boolean
  source?: "foursquare" | "google"
  googlePlaceId?: string
  rating?: number
  userRatingCount?: number
}

type VenueStats = {
  validated: number
  dropped: number
  backfilled: number
  googleCalls: number
}

type GetVenuesOutput = { kind: "ok"; venues: Venue[]; stats?: VenueStats }

// --- Google validation/backfill tuning (ADR 0020) ---
// Validate at most 15 venues (3 cells x 5) and backfill at most 3 cells (one
// call each), with a hard belt-and-suspenders cap of 20 calls per analysis run.
const GOOGLE_VALIDATE_LIMIT = 15
const GOOGLE_BACKFILL_LIMIT = 3
const MAX_GOOGLE_CALLS = 20
// A venue counts as OPERATIONAL only if Google resolves a place within this many
// metres of its Foursquare coords; further away is treated as a different place.
const VALIDATE_BIAS_M = 250
const VALIDATE_MATCH_M = 500
// Backfill searches a wider circle around the cell centroid.
const BACKFILL_BIAS_M = 400
const BACKFILL_PAGE_SIZE = 5
// A backfilled Google venue is a duplicate of a kept one if it shares a name
// (case-insensitive) AND sits within this many metres.
const DEDUPE_M = 100
const MAX_VENUES_PER_CELL = 5

// Non-operational Google business statuses — a definitive "dead place" signal.
const CLOSED_STATUSES = new Set(["CLOSED_PERMANENTLY", "CLOSED_TEMPORARILY"])

/**
 * Fetch representative venues for the finalist areas (ADR 0008 funnel, step 4),
 * then validate their LIVENESS against Google Places (ADR 0020) so a stale
 * Foursquare snapshot never recommends a closed or vanished venue.
 *
 * ClickHouse pass: per-cell top 5, ranked so a category-keyword MATCH comes
 * first, then any SOCIAL venue, then non-empty names, then fsq_place_id. The
 * WHERE keeps only matched or social rows so a filter miss degrades to good
 * social venues instead of offices or nothing.
 *
 * Google pass (only when GOOGLE_PLACES_KEY is set): each venue is checked with a
 * pageSize-1 Text Search biased to its coords; a result within 500m AND
 * OPERATIONAL is kept+verified, a closed/far/absent result is DROPPED, and a
 * failed call keeps the venue UNVERIFIED (availability != closure — never empty
 * the plan on an error). Cells left with <3 venues get ONE backfill Text Search
 * around their centroid, deduped against survivors. Without the key, the whole
 * Google pass is skipped and ClickHouse venues pass through unvalidated.
 */
export const getVenuesTask = schemaTask({
  id: "ch-get-venues",
  schema: getVenuesPayload,
  maxDuration: 60,
  run: async ({ h3Cells, categories }): Promise<GetVenuesOutput> => {
    const hasCategories = Boolean(categories && categories.length > 0)
    // Category match = case-insensitive substring of ANY keyword against ANY
    // Foursquare taxonomy label ("steak" ⊂ "Dining and Drinking > Restaurant >
    // Steakhouse"). No keywords ⇒ nothing matches; ranking falls back to social.
    const matchedExpr = hasCategories
      ? "arrayExists(l -> arrayExists(t -> positionCaseInsensitive(l, t) > 0, {cats:Array(String)}), category_labels)"
      : "0"

    const rows = await chQuery<{
      h3: string
      fsqPlaceId: string
      name: string
      lat: number
      lng: number
      category: string
      address: string
      postcode: string
      locality: string
      matched: number
    }>(
      `SELECT toString(h3_8) AS h3,
              fsqPlaceId, name, lat, lng, category, address, postcode, locality,
              matched
       FROM (
         SELECT h3_8, fsqPlaceId, name, lat, lng, category, address, postcode,
                locality, matched, social,
                ROW_NUMBER() OVER (
                  PARTITION BY h3_8
                  ORDER BY matched DESC, social DESC, notEmpty(name) DESC,
                           fsqPlaceId
                ) AS rn
         FROM (
           SELECT h3_8,
                  fsq_place_id AS fsqPlaceId,
                  name,
                  latitude AS lat,
                  longitude AS lng,
                  primary_category AS category,
                  address,
                  postcode,
                  locality,
                  ${matchedExpr} AS matched,
                  arrayExists(
                    l -> startsWith(l, 'Dining and Drinking')
                      OR startsWith(l, 'Nightlife')
                      OR startsWith(l, 'Arts and Entertainment')
                      OR startsWith(l, 'Landmarks and Outdoors')
                      OR startsWith(l, 'Sports and Recreation'),
                    category_labels
                  ) AS social
           FROM places
           WHERE h3_8 IN (SELECT toUInt64(arrayJoin({cells:Array(String)})))
             AND is_closed = 0 AND has_quality_warning = 0
         )
         WHERE matched OR social
       )
       WHERE rn <= 5
       ORDER BY h3, rn`,
      { cells: h3Cells, ...(hasCategories ? { cats: categories } : {}) }
    )

    // Group rows into per-cell venue lists (preserving CH ranking order) and
    // remember each cell's original centroid for backfill.
    const initialByCell = new Map<string, Venue[]>()
    for (const r of rows) {
      const address =
        r.address.trim() ||
        [r.locality, r.postcode].filter((s) => s.trim()).join(", ")
      const venue: Venue = {
        h3: r.h3,
        fsqPlaceId: r.fsqPlaceId,
        name: r.name,
        lat: r.lat,
        lng: r.lng,
        category: r.category,
        matched: r.matched === 1,
        ...(address ? { address } : {}),
      }
      const list = initialByCell.get(r.h3) ?? []
      list.push(venue)
      initialByCell.set(r.h3, list)
    }

    // Without a Google key the Google pass is skipped entirely — ClickHouse
    // venues pass through unvalidated (degrades to pre-ADR-0020 behavior).
    if (!process.env.GOOGLE_PLACES_KEY) {
      const venues = [...initialByCell.values()].flat()
      logger.info("venues fetched (no Google key — unvalidated)", {
        cells: h3Cells.length,
        venues: venues.length,
      })
      return { kind: "ok", venues }
    }

    const venues = await validateAndBackfill(initialByCell, {
      hasCategories,
      categories: categories ?? [],
    })
    return venues
  },
})

// --- Google validation + backfill (module scope; pure over its args aside from
// the Google calls searchText makes). ---

async function validateAndBackfill(
  initialByCell: Map<string, Venue[]>,
  opts: { hasCategories: boolean; categories: string[] }
): Promise<GetVenuesOutput> {
  // Centroid per cell from the ORIGINAL (pre-drop) coords — a stable anchor for
  // backfill even after validation removes venues.
  const centroidByCell = new Map<string, { lat: number; lng: number }>()
  for (const [h3, list] of initialByCell) {
    if (list.length === 0) continue
    const sum = list.reduce(
      (acc, v) => ({ lat: acc.lat + v.lat, lng: acc.lng + v.lng }),
      { lat: 0, lng: 0 }
    )
    centroidByCell.set(h3, {
      lat: sum.lat / list.length,
      lng: sum.lng / list.length,
    })
  }

  // Validate up to 15 venues in parallel; any beyond that (can't happen with
  // rn<=5 across 3 cells, but guarded) pass through unverified.
  const allInitial = [...initialByCell.values()].flat()
  const toValidate = allInitial.slice(0, GOOGLE_VALIDATE_LIMIT)
  const beyond = allInitial.slice(GOOGLE_VALIDATE_LIMIT)
  let googleCalls = toValidate.length

  const validated = await Promise.all(toValidate.map(validateVenue))

  const keptByCell = new Map<string, Venue[]>()
  for (const h3 of initialByCell.keys()) keptByCell.set(h3, [])
  let dropped = 0
  for (const result of validated) {
    if (result.keep) keptByCell.get(result.venue.h3)?.push(result.venue)
    else dropped++
  }
  for (const v of beyond) keptByCell.get(v.h3)?.push({ ...v, source: "foursquare" })

  // Backfill cells left thin (<3 survivors), one Text Search each, honoring both
  // the per-run backfill limit and the hard call cap.
  const backfillCells: Array<{ h3: string; centroid: { lat: number; lng: number } }> =
    []
  for (const [h3, kept] of keptByCell) {
    if (kept.length >= 3) continue
    const centroid = centroidByCell.get(h3)
    if (!centroid) continue // cell had zero CH venues — nothing to anchor on
    if (backfillCells.length >= GOOGLE_BACKFILL_LIMIT) break
    if (googleCalls + backfillCells.length + 1 > MAX_GOOGLE_CALLS) break
    backfillCells.push({ h3, centroid })
  }
  googleCalls += backfillCells.length

  const backfillResults = await Promise.all(
    backfillCells.map((c) =>
      backfillCell(c.centroid, {
        h3: c.h3,
        hasCategories: opts.hasCategories,
        categories: opts.categories,
      })
    )
  )

  let backfilled = 0
  for (let i = 0; i < backfillCells.length; i++) {
    const h3 = backfillCells[i]!.h3
    const kept = keptByCell.get(h3)
    if (!kept) continue
    for (const cand of backfillResults[i]!) {
      // Dedupe against everything already kept in the cell (CH survivors AND
      // earlier backfill additions for the same cell).
      if (kept.some((e) => isDuplicate(cand, e))) continue
      kept.push(cand)
      backfilled++
    }
  }

  // Order per cell (matched+verified, then verified, then unverified) and cap.
  const venues: Venue[] = []
  for (const list of keptByCell.values()) {
    const ordered = list
      .map((v, idx) => ({ v, idx }))
      .sort((a, b) => venueRank(a.v) - venueRank(b.v) || a.idx - b.idx)
      .slice(0, MAX_VENUES_PER_CELL)
      .map((x) => x.v)
    venues.push(...ordered)
  }

  const stats: VenueStats = {
    validated: toValidate.length,
    dropped,
    backfilled,
    googleCalls,
  }
  logger.info("venues validated + backfilled", {
    cells: initialByCell.size,
    venues: venues.length,
    ...stats,
  })
  return { kind: "ok", venues, stats }
}

/**
 * Validate ONE Foursquare venue against Google's live index. Keep+verify when
 * Google resolves it OPERATIONAL within 500m; keep UNVERIFIED when the call
 * failed (can't check != closed); DROP when Google says closed, resolves it
 * >500m away (a different place), or finds nothing (gone).
 */
async function validateVenue(
  v: Venue
): Promise<{ keep: boolean; venue: Venue }> {
  const places = await searchText({
    query: v.name,
    lat: v.lat,
    lng: v.lng,
    radius: VALIDATE_BIAS_M,
    pageSize: 1,
  })

  // (c) call failed / timeout / no key — keep, unverified.
  if (places === null) {
    return { keep: true, venue: { ...v, source: "foursquare" } }
  }

  const match = places[0]
  const lat = match?.location?.latitude
  const lng = match?.location?.longitude
  // (b) no resolvable result — the venue is gone; DROP.
  if (!match || typeof lat !== "number" || typeof lng !== "number") {
    return { keep: false, venue: v }
  }
  // (b) resolved too far away — a same-named place elsewhere; DROP.
  if (haversineMeters(v, { lat, lng }) > VALIDATE_MATCH_M) {
    return { keep: false, venue: v }
  }
  // (b) resolved but not OPERATIONAL (closed, or status absent) — DROP. Only a
  // confirmed OPERATIONAL match is trusted, per the "never a dead place" goal;
  // over-dropping is compensated by backfill on thin cells.
  if (match.businessStatus !== "OPERATIONAL") {
    return { keep: false, venue: v }
  }

  // (a) OPERATIONAL within range — keep, verified, enriched.
  return {
    keep: true,
    venue: {
      ...v,
      source: "foursquare",
      verified: true,
      ...(match.id ? { googlePlaceId: match.id } : {}),
      ...(typeof match.rating === "number" ? { rating: match.rating } : {}),
      ...(typeof match.userRatingCount === "number"
        ? { userRatingCount: match.userRatingCount }
        : {}),
    },
  }
}

/** ONE backfill Text Search around a cell centroid → mapped Google venues. */
async function backfillCell(
  centroid: { lat: number; lng: number },
  opts: { h3: string; hasCategories: boolean; categories: string[] }
): Promise<Venue[]> {
  const query =
    opts.hasCategories && opts.categories.length > 0
      ? opts.categories.join(" ")
      : "restaurant bar cafe"
  const places = await searchText({
    query,
    lat: centroid.lat,
    lng: centroid.lng,
    radius: BACKFILL_BIAS_M,
    pageSize: BACKFILL_PAGE_SIZE,
  })
  if (!places) return []

  const out: Venue[] = []
  for (const p of places) {
    const lat = p.location?.latitude
    const lng = p.location?.longitude
    const name = p.displayName?.text
    if (typeof lat !== "number" || typeof lng !== "number" || !name) continue
    // Backfill comes from Google's live index, but the search can still surface
    // a closed place — skip those to honor "never a dead place".
    if (p.businessStatus && CLOSED_STATUSES.has(p.businessStatus)) continue
    out.push({
      h3: opts.h3,
      name,
      lat,
      lng,
      source: "google",
      verified: true,
      matched: opts.hasCategories,
      ...(p.id ? { googlePlaceId: p.id } : {}),
      ...(typeof p.rating === "number" ? { rating: p.rating } : {}),
      ...(typeof p.userRatingCount === "number"
        ? { userRatingCount: p.userRatingCount }
        : {}),
    })
  }
  return out
}

/** Ordering rank: matched+verified (0) < verified (1) < unverified (2). */
function venueRank(v: Venue): number {
  if (v.verified && v.matched) return 0
  if (v.verified) return 1
  return 2
}

/** Same name (case-insensitive) AND within DEDUPE_M metres. */
function isDuplicate(a: Venue, b: Venue): boolean {
  return (
    a.name.toLowerCase() === b.name.toLowerCase() &&
    haversineMeters(a, b) < DEDUPE_M
  )
}
