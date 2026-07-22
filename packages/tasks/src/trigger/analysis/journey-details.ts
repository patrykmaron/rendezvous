import { batch, logger, schemaTask } from "@trigger.dev/sdk"
import { z } from "zod"

import type { JourneyOption } from "../../tfl/schemas"
import { tflJourneyPlanTask } from "../tfl-journey"
import { nextSaturdayDeparture } from "./route-matrix"
import { modesFor, STEP_FREE_PREFERENCE, tflDateTimeFrom } from "./travel"
import { analysisOrigin, type AnalysisOrigin, type PlanJourney } from "./types"

const journeyTarget = z.object({
  h3: z.string(),
  lat: z.number(),
  lng: z.number(),
})

const journeyDetailsPayload = z.object({
  origins: z.array(analysisOrigin).min(1),
  /** Top-3 winning cells (centroids) to fetch exact journeys to. */
  targets: z.array(journeyTarget).min(1).max(3),
  /** London wall-clock "yyyy-MM-ddTHH:mm"; absent → next-Saturday fallback. */
  eventAt: z.string().optional(),
})

type JourneyDetailsOutput = {
  kind: "ok"
  journeys: Array<{ h3: string; participantId: string; journey: PlanJourney }>
}

/** min-duration journey (the depart-at fallback pick, and the last resort). */
function minDuration(journeys: JourneyOption[]): JourneyOption | undefined {
  return journeys.reduce<JourneyOption | undefined>(
    (best, j) => (!best || j.durationMinutes < best.durationMinutes ? j : best),
    undefined
  )
}

/**
 * Journey pick rule. With eventAt set (timeIs=Arriving) choose the LATEST
 * `startDateTime` among journeys arriving by eventAt (leave as late as possible
 * while still on time); if none qualify, fall back to min duration. Without
 * eventAt (Departing), min duration. TfL start/arrival are zone-less
 * London-local ISO, so lexicographic string compare on the shared prefix is
 * valid (eventAt has no seconds — slice arrival to the minute).
 */
function pickJourney(
  journeys: JourneyOption[],
  eventAt: string | undefined
): JourneyOption | undefined {
  if (journeys.length === 0) return undefined
  if (eventAt) {
    const onTime = journeys.filter(
      (j) => j.arrivalDateTime && j.arrivalDateTime.slice(0, 16) <= eventAt
    )
    if (onTime.length > 0) {
      return onTime.reduce((best, j) =>
        j.startDateTime > best.startDateTime ? j : best
      )
    }
  }
  return minDuration(journeys)
}

/**
 * Fetch exact door-to-door journeys (with geometry) for every origin to each of
 * the top-3 target cells. Runs in room-agent's deterministic finish path after
 * ranking. Failure-isolated: any per-pair failure (run failed, no_journeys,
 * disambiguation) is simply omitted — the task always returns kind "ok"
 * (possibly empty), so a TfL blip can never fail the plan. Children throttle
 * through the shared tflQueue (<= 3N calls).
 */
export const journeyDetailsTask = schemaTask({
  id: "journey-details",
  schema: journeyDetailsPayload,
  maxDuration: 300,
  run: async ({ origins, targets, eventAt }): Promise<JourneyDetailsOutput> => {
    const dep = nextSaturdayDeparture()
    const when = eventAt ? tflDateTimeFrom(eventAt) : null
    // eventAt is only a valid Arriving anchor when it parsed (future + shaped).
    const anchor = when ? eventAt : undefined

    type Pair = { o: AnalysisOrigin; t: z.infer<typeof journeyTarget> }
    const pairs: Pair[] = origins.flatMap((o) => targets.map((t) => ({ o, t })))

    const items = pairs.map(({ o, t }) => ({
      id: "tfl-journey-plan" as const,
      payload: {
        from: `${o.lat},${o.lng}`,
        to: `${t.lat},${t.lng}`,
        mode: modesFor(o),
        includeGeometry: true,
        ...(o.requiresStepFree
          ? { accessibilityPreference: STEP_FREE_PREFERENCE }
          : {}),
        ...(when
          ? { date: when.date, time: when.time, timeIs: "Arriving" as const }
          : { date: dep.date, time: dep.time, timeIs: "Departing" as const }),
      },
    }))

    const result = await batch.triggerAndWait<typeof tflJourneyPlanTask>(items)

    const journeys: JourneyDetailsOutput["journeys"] = []
    result.runs.forEach((run, i) => {
      const { o, t } = pairs[i]!
      if (!run.ok) return
      const out = run.output
      if (out.kind !== "journeys") return
      const picked = pickJourney(out.journeys, anchor)
      if (!picked) return
      journeys.push({
        h3: t.h3,
        participantId: o.participantId,
        journey: {
          durationMinutes: picked.durationMinutes,
          startDateTime: picked.startDateTime,
          arrivalDateTime: picked.arrivalDateTime,
          ...(picked.fareTotalPence !== undefined
            ? { fareTotalPence: picked.fareTotalPence }
            : {}),
          legs: picked.legs.map((l) => ({
            mode: l.mode,
            ...(l.lineName ? { lineName: l.lineName } : {}),
            instruction: l.instruction,
            departureTime: l.departureTime,
            arrivalTime: l.arrivalTime,
            ...(l.durationMinutes !== undefined
              ? { durationMinutes: l.durationMinutes }
              : {}),
            isDisrupted: l.isDisrupted,
            ...(l.pathPoints ? { pathPoints: l.pathPoints } : {}),
          })),
        },
      })
    })

    logger.info("journey details complete", {
      pairs: pairs.length,
      journeys: journeys.length,
    })
    return { kind: "ok", journeys }
  },
})
