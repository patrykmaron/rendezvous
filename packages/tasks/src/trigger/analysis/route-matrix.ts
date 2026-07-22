import {
  chCommand,
  chInsert,
  toChDateTime,
} from "@workspace/db/clickhouse/query"
import { batch, logger, metadata, schemaTask } from "@trigger.dev/sdk"
import { z } from "zod"

import type { JourneyLeg, JourneyOption } from "../../tfl/schemas"
import { tflJourneyPlanTask } from "../tfl-journey"
import { modesFor, STEP_FREE_PREFERENCE, tflDateTimeFrom } from "./travel"
import { analysisOrigin, candidate } from "./types"

const routeMatrixPayload = z.object({
  analysisId: z.uuid(),
  roomId: z.uuid(),
  roomRevision: z.number().int().nonnegative(),
  origins: z.array(analysisOrigin).min(1),
  candidates: z.array(candidate).min(1),
  /** London wall-clock "yyyy-MM-ddTHH:mm" target time; absent → Saturday fallback. */
  eventAt: z.string().optional(),
})

type RouteMatrixOutput =
  | { kind: "ok"; inserted: number; okCount: number; failedCount: number }
  | { kind: "no_routes" }

/**
 * Next Saturday at 19:00 — a representative evening-out departure, used as the
 * fallback anchor when the room has no eventAt. Exported for journey-details,
 * which shares the same fallback so scoring and journeys stay consistent.
 */
export function nextSaturdayDeparture(): {
  date: string
  time: string
  utc: Date
} {
  const now = new Date()
  const day = now.getUTCDay() // 0 Sun … 6 Sat
  let delta = (6 - day + 7) % 7
  if (delta === 0) delta = 7 // always a future Saturday
  const d = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + delta,
      19,
      0,
      0
    )
  )
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0")
  const dd = String(d.getUTCDate()).padStart(2, "0")
  return { date: `${yyyy}${mm}${dd}`, time: "1900", utc: d }
}

const MS = 1000

/** Sum the durations of the walking legs (leg times are ISO strings). */
function walkingSeconds(legs: JourneyLeg[]): number {
  let total = 0
  for (const leg of legs) {
    if (leg.mode !== "walking") continue
    const start = Date.parse(leg.departureTime)
    const end = Date.parse(leg.arrivalTime)
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue
    total += Math.round((end - start) / MS)
  }
  return total
}

function bestJourney(journeys: JourneyOption[]): JourneyOption | undefined {
  return journeys.reduce<JourneyOption | undefined>((best, j) => {
    if (!best || j.durationMinutes < best.durationMinutes) return j
    return best
  }, undefined)
}

/**
 * Route every origin to every candidate centroid (ADR 0008 funnel, step 2),
 * fanning out `tfl-journey-plan` child runs through the shared `tfl` queue and
 * writing one route_observations row per pair — including failures — for the
 * ClickHouse scorer. Best journey per pair = minimum duration. TfL durations
 * are MINUTES (see mapJourneyResponse); stored as seconds.
 */
export const routeMatrixTask = schemaTask({
  id: "route-matrix",
  schema: routeMatrixPayload,
  maxDuration: 600,
  run: async ({
    analysisId,
    roomId,
    roomRevision,
    origins,
    candidates,
    eventAt,
  }): Promise<RouteMatrixOutput> => {
    const dep = nextSaturdayDeparture()
    // Journey anchor: arrive-by the eventAt instant (parsed as UTC — the same
    // approximation nextSaturdayDeparture makes) when set + valid + future,
    // else the fallback Saturday. `when` also selects Arriving vs Departing.
    const when = eventAt ? tflDateTimeFrom(eventAt) : null
    const anchorUtc = when && eventAt ? new Date(`${eventAt}:00Z`) : dep.utc
    const departureTime = toChDateTime(anchorUtc)

    metadata.root.set("routesTotal", origins.length * candidates.length)
    metadata.root.set("routesDone", 0)

    // Flatten to (origin, candidate) pairs; batch preserves item order, so the
    // pair at index i maps to result.runs[i]. Modes + step-free are per-origin.
    const pairs = origins.flatMap((o) => candidates.map((c) => ({ o, c })))
    const items = pairs.map(({ o, c }) => ({
      id: "tfl-journey-plan" as const,
      payload: {
        from: `${o.lat},${o.lng}`,
        to: `${c.lat},${c.lng}`,
        mode: modesFor(o),
        ...(o.requiresStepFree
          ? { accessibilityPreference: STEP_FREE_PREFERENCE }
          : {}),
        ...(when
          ? { date: when.date, time: when.time, timeIs: "Arriving" as const }
          : { date: dep.date, time: dep.time, timeIs: "Departing" as const }),
      },
    }))

    const result = await batch.triggerAndWait<typeof tflJourneyPlanTask>(items)

    const rows = result.runs.map((run, i) => {
      const { o, c } = pairs[i]!

      let routeStatus = "error"
      let durationSeconds = 0
      let walkingSecs = 0
      let interchangeCount = 0

      if (run.ok) {
        const out = run.output
        if (out.kind === "journeys") {
          const best = bestJourney(out.journeys)
          if (best) {
            routeStatus = "ok"
            durationSeconds = Math.round(best.durationMinutes * 60)
            walkingSecs = walkingSeconds(best.legs)
            interchangeCount = Math.max(0, best.legs.length - 1)
          } else {
            routeStatus = "no_journeys"
          }
        } else if (out.kind === "no_journeys") {
          routeStatus = "no_journeys"
        } else {
          routeStatus = "disambiguation"
        }
      }

      return {
        analysis_id: analysisId,
        room_id: roomId,
        room_revision: roomRevision,
        participant_id: o.participantId,
        candidate_h3: c.h3,
        provider: "tfl",
        // Honest per-origin mode set, e.g. "bus+tube+walking" (<= ~16 combos —
        // fine for LowCardinality). Replaces the old dishonest "mixed".
        transport_mode: modesFor(o).slice().sort().join("+"),
        // Journey anchor time (arrival target when timeIs=Arriving, else the
        // fallback Saturday departure). Analytics only — nothing reads it.
        departure_time: departureTime,
        duration_seconds: durationSeconds,
        walking_seconds: walkingSecs,
        interchange_count: interchangeCount,
        // TfL enforces the step-free preference, so an existing journey IS
        // accessible; a step-free request that yields no journey scores 0.
        accessibility_ok: o.requiresStepFree && routeStatus !== "ok" ? 0 : 1,
        route_status: routeStatus,
      }
    })

    // Trigger.dev retries this run up to maxAttempts (trigger.config.ts) on
    // transient failure; route_observations is plain MergeTree (no dedup on
    // re-insert), so clear any rows a prior attempt already committed for
    // this analysisId before inserting, keeping the run idempotent.
    await chCommand(
      "DELETE FROM route_observations WHERE analysis_id = {analysisId:UUID}",
      { analysisId }
    )
    await chInsert("route_observations", rows)

    const okCount = rows.filter((r) => r.route_status === "ok").length
    const failedCount = rows.length - okCount

    logger.info("route matrix complete", {
      inserted: rows.length,
      okCount,
      failedCount,
    })

    if (okCount === 0) return { kind: "no_routes" }
    return { kind: "ok", inserted: rows.length, okCount, failedCount }
  },
})
