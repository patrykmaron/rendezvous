import { logger, schemaTask } from "@trigger.dev/sdk"

import { tflFetch, tflHttpError, tflJson } from "../tfl/client"
import { mapBikePoint, mapBikePointSearchHit } from "../tfl/mappers"
import {
  bikePointGetPayload,
  bikePointSearchPayload,
  bikePointsListPayload,
  type BikePointSearchHit,
  type BikePointStatus,
} from "../tfl/schemas"

/** All ~800 Santander dock stations with live occupancy. */
export const tflBikePointsListTask = schemaTask({
  id: "tfl-bikepoints-list",
  schema: bikePointsListPayload,
  maxDuration: 120,
  run: async (): Promise<{ count: number; bikePoints: BikePointStatus[] }> => {
    const res = await tflFetch("/BikePoint")
    if (res.status !== 200) throw await tflHttpError(res)

    const body = await tflJson<unknown>(res)
    const bikePoints = (Array.isArray(body) ? body : []).map(mapBikePoint)
    logger.info("bike points listed", { count: bikePoints.length })
    return { count: bikePoints.length, bikePoints }
  },
})

/** Single dock station with live occupancy; unknown id is a semantic outcome. */
export const tflBikePointGetTask = schemaTask({
  id: "tfl-bikepoint-get",
  schema: bikePointGetPayload,
  maxDuration: 60,
  run: async ({
    id,
  }): Promise<
    | { kind: "found"; bikePoint: BikePointStatus }
    | { kind: "not_found"; id: string }
  > => {
    const res = await tflFetch(`/BikePoint/${encodeURIComponent(id)}`)

    if (res.status === 404) {
      // Deterministic — don't burn task retries on an unknown id.
      logger.warn("bike point not found", { id })
      return { kind: "not_found", id }
    }
    if (res.status !== 200) throw await tflHttpError(res)

    return { kind: "found", bikePoint: mapBikePoint(await tflJson(res)) }
  },
})

/**
 * Name search. Results carry no occupancy data — chain into tfl-bikepoint-get
 * for live availability.
 */
export const tflBikePointsSearchTask = schemaTask({
  id: "tfl-bikepoints-search",
  schema: bikePointSearchPayload,
  maxDuration: 60,
  run: async ({
    query,
  }): Promise<{ count: number; results: BikePointSearchHit[] }> => {
    const res = await tflFetch("/BikePoint/Search", { query })
    if (res.status !== 200) throw await tflHttpError(res)

    const body = await tflJson<unknown>(res)
    const results = (Array.isArray(body) ? body : []).map(mapBikePointSearchHit)
    logger.info("bike point search complete", { query, count: results.length })
    return { count: results.length, results }
  },
})
