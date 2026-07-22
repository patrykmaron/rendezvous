import { chQuery } from "@workspace/db/clickhouse/query"
import { logger, schemaTask } from "@trigger.dev/sdk"
import { z } from "zod"

import { areaNameSubquery } from "./area-name"
import { analysisOrigin, type Candidate } from "./types"

const generateCandidatesPayload = z.object({
  analysisId: z.uuid(),
  roomId: z.uuid(),
  roomRevision: z.number().int().nonnegative(),
  origins: z.array(analysisOrigin).min(2),
})

type GenerateCandidatesOutput =
  | { kind: "ok"; candidates: Candidate[] }
  | { kind: "no_candidates" }

const EARTH_RADIUS_KM = 6371

/** Great-circle distance in km between two WGS84 points. */
function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Generate candidate meeting areas (H3 res-8 cells) from the group's travel
 * envelope (ADR 0008 funnel, step 1). Rings the centroid cell, keeps cells
 * with enough venues, and returns the densest, enriched with a display name
 * and centroid.
 *
 * geoToH3(lat, lng, 8) matches the argument order that materialised
 * places.h3_8 (verified live: the round trip h3ToGeo(geoToH3(51.5072,-0.1276,8))
 * ≈ {51.508, -0.130}). Cells cross the JS boundary as decimal strings; the
 * enrichment IN-list is bound as Array(String) then toUInt64'd in SQL, because
 * the ClickHouse client quotes array elements and Array(UInt64) rejects quotes.
 */
export const generateCandidatesTask = schemaTask({
  id: "ch-generate-candidates",
  schema: generateCandidatesPayload,
  maxDuration: 60,
  run: async ({ origins }): Promise<GenerateCandidatesOutput> => {
    const centroid = {
      lat: origins.reduce((sum, o) => sum + o.lat, 0) / origins.length,
      lng: origins.reduce((sum, o) => sum + o.lng, 0) / origins.length,
    }

    let maxPairwiseKm = 0
    for (let i = 0; i < origins.length; i++) {
      for (let j = i + 1; j < origins.length; j++) {
        maxPairwiseKm = Math.max(
          maxPairwiseKm,
          haversineKm(origins[i]!, origins[j]!)
        )
      }
    }
    // ~0.9 km per res-8 hex; ring wide enough to cover the group's spread.
    const k = Math.min(15, Math.max(3, Math.ceil(maxPairwiseKm / 0.9)))

    const dense = await chQuery<{ h3: string; venue_density: string }>(
      `WITH arrayJoin(h3kRing(geoToH3({lat:Float64},{lng:Float64},8), {k:UInt8})) AS cell
       SELECT toString(cell) AS h3,
              sum(place_count) AS venue_density
       FROM area_category_counts
       WHERE h3_8 = cell
       GROUP BY cell HAVING venue_density >= {minVenues:UInt32}
       ORDER BY venue_density DESC LIMIT {limit:UInt16}`,
      { lat: centroid.lat, lng: centroid.lng, k, minVenues: 5, limit: 25 }
    )

    if (dense.length === 0) {
      logger.warn("no candidate areas met the venue floor", {
        centroid,
        k,
        maxPairwiseKm,
      })
      return { kind: "no_candidates" }
    }

    const cells = dense.map((r) => r.h3)
    // One enrichment query: most-specific area name (LEFT JOIN so a cell with
    // no specific locality keeps its centroid and falls back below, instead of
    // being dropped) + centroid (h3ToGeo returns a (latitude, longitude) tuple
    // on this cluster).
    const enriched = await chQuery<{
      h3: string
      name: string
      lat: number
      lng: number
    }>(
      `SELECT toString(pl.h3_8) AS h3,
              nm.name AS name,
              h3ToGeo(pl.h3_8).1 AS lat,
              h3ToGeo(pl.h3_8).2 AS lng
       FROM (
         SELECT h3_8
         FROM places
         WHERE h3_8 IN (SELECT toUInt64(arrayJoin({cells:Array(String)})))
         GROUP BY h3_8
       ) AS pl
       LEFT JOIN (
         ${areaNameSubquery(
           "h3_8 IN (SELECT toUInt64(arrayJoin({cells:Array(String)})))"
         )}
       ) AS nm ON pl.h3_8 = nm.h3_8`,
      { cells }
    )
    const enrichedByH3 = new Map(enriched.map((e) => [e.h3, e]))

    const candidates: Candidate[] = dense.flatMap((row) => {
      const meta = enrichedByH3.get(row.h3)
      if (!meta) return []
      return [
        {
          h3: row.h3,
          lat: meta.lat,
          lng: meta.lng,
          name: meta.name || "London",
          venueDensity: Number(row.venue_density),
        },
      ]
    })

    logger.info("candidate areas generated", {
      count: candidates.length,
      k,
      centroid,
    })
    return { kind: "ok", candidates }
  },
})
