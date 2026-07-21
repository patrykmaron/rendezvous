import { logger, metadata, schemaTask } from "@trigger.dev/sdk"

import { tflFetch, tflHttpError, tflJson } from "../tfl/client"
import { mapDisambiguation, mapJourneyResponse, mapMode } from "../tfl/mappers"
import {
  journeyModesPayload,
  journeyPlanPayload,
  rawApiError,
  type PlanJourneyOutput,
  type TransportMode,
} from "../tfl/schemas"
import { tflQueue } from "./queues"

/**
 * Journey Planner search between two locations. Child task for agent
 * pipelines (ADR 0013): coordinates resolve directly to journeys; free text
 * returns kind "disambiguation" with options to re-trigger with.
 */
export const tflJourneyPlanTask = schemaTask({
  id: "tfl-journey-plan",
  schema: journeyPlanPayload,
  queue: tflQueue,
  maxDuration: 120,
  run: async (payload): Promise<PlanJourneyOutput> => {
    const {
      from,
      to,
      mode,
      nationalSearch,
      maxWalkingMinutes,
      useMultiModalCall,
      ...stringParams
    } = payload

    const res = await tflFetch(
      `/Journey/JourneyResults/${encodeURIComponent(from)}/to/${encodeURIComponent(to)}`,
      {
        ...stringParams,
        mode: mode?.join(","),
        nationalSearch:
          nationalSearch === undefined ? undefined : String(nationalSearch),
        maxWalkingMinutes:
          maxWalkingMinutes === undefined
            ? undefined
            : String(maxWalkingMinutes),
        useMultiModalCall:
          useMultiModalCall === undefined
            ? undefined
            : String(useMultiModalCall),
      }
    )

    if (res.status === 200) {
      const journeys = mapJourneyResponse(await tflJson(res))
      // Progress counter on the root run (route-matrix parent); a no-op when
      // this task runs standalone.
      metadata.root.increment("routesDone", 1)
      logger.info("journey plan resolved", {
        from,
        to,
        journeys: journeys.length,
      })
      return { kind: "journeys", journeys }
    }

    if (res.status === 300) {
      logger.warn("ambiguous journey location, returning disambiguation", {
        from,
        to,
      })
      return mapDisambiguation(await tflJson(res))
    }

    if (res.status === 404) {
      const text = await res.text()
      let message = text.slice(0, 300)
      try {
        const apiError = rawApiError.parse(JSON.parse(text))
        if (apiError.message) message = apiError.message
      } catch {
        // Not ApiError JSON — keep the raw snippet.
      }
      metadata.root.increment("routesFailed", 1)
      // A no-route answer is still a completed journey slot — advance the
      // parent's (done/total) counter too, or routing progress stalls below
      // total whenever any leg 404s. routesFailed still records the failure.
      metadata.root.increment("routesDone", 1)
      logger.warn("journey planner found no route", { from, to, message })
      return { kind: "no_journeys", message }
    }

    throw await tflHttpError(res)
  },
})

/**
 * Live journey-planner mode ids (e.g. "bus", "national-rail", "cycle-hire").
 * The published OpenAPI mode list is wrong — use this instead of hardcoding.
 */
export const tflJourneyModesTask = schemaTask({
  id: "tfl-journey-modes",
  schema: journeyModesPayload,
  maxDuration: 60,
  run: async (): Promise<{ modes: TransportMode[] }> => {
    const res = await tflFetch("/Journey/Meta/Modes")
    if (res.status !== 200) throw await tflHttpError(res)

    const body = await tflJson<unknown>(res)
    const modes = (Array.isArray(body) ? body : []).map(mapMode)
    logger.info("journey modes fetched", { count: modes.length })
    return { modes }
  },
})
