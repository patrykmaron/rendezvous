import { chQuery } from "@workspace/db/clickhouse/query"
import { logger, schemaTask } from "@trigger.dev/sdk"
import { z } from "zod"

const getVenuesPayload = z.object({
  h3Cells: z.array(z.string()).min(1).max(3),
  categories: z.array(z.string()).optional(),
})

export type Venue = {
  h3: string
  fsqPlaceId: string
  name: string
  lat: number
  lng: number
  category: string
  address?: string
  // True when this venue matched the model's category keywords (so the agent
  // can honestly say the preference was met). Absent when no keywords were
  // passed (nothing to match against).
  matched?: boolean
}

type GetVenuesOutput = { kind: "ok"; venues: Venue[] }

/**
 * Fetch representative venues for the finalist areas (ADR 0008 funnel, step 4).
 * Per-cell top 5, ranked so a category-keyword MATCH comes first, then any
 * SOCIAL venue (dining/nightlife/entertainment/outdoors/sports), then non-empty
 * names, then fsq_place_id for a stable tiebreak. The WHERE keeps only matched
 * or social rows, so a filter miss ("steak" with no steakhouse in a cell)
 * degrades to good social venues instead of returning offices or nothing.
 * Cells bind as Array(String) → toUInt64 in SQL.
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

    const venues: Venue[] = rows.map((r) => {
      const address =
        r.address.trim() ||
        [r.locality, r.postcode].filter((s) => s.trim()).join(", ")
      return {
        h3: r.h3,
        fsqPlaceId: r.fsqPlaceId,
        name: r.name,
        lat: r.lat,
        lng: r.lng,
        category: r.category,
        matched: r.matched === 1,
        ...(address ? { address } : {}),
      }
    })

    logger.info("venues fetched", {
      cells: h3Cells.length,
      venues: venues.length,
    })
    return { kind: "ok", venues }
  },
})
