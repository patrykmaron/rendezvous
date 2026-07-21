import { eq, sql } from "@workspace/db/postgres"
import { withRoomRevision } from "@workspace/db/revision"
import { planSnapshots } from "@workspace/db/schema"
import { logger, schemaTask } from "@trigger.dev/sdk"
import { z } from "zod"

import { broadcastRoomEvent } from "../../lib/liveblocks"
import { planResult } from "./types"

const finalizePlanPayload = z.object({
  analysisId: z.uuid(),
  roomId: z.uuid(),
  result: planResult,
})

/**
 * Persist a completed analysis and nudge the room (ADR 0008 funnel, final
 * step). Writes the denormalised PlanResult onto the plan_snapshots row and
 * appends an `analysis_completed` event in ONE transaction (ADR 0007), then
 * broadcasts `plan:updated` so open clients re-fetch (ADR 0012 — the broadcast
 * is an ephemeral nudge, not the source of truth).
 */
export const finalizePlanTask = schemaTask({
  id: "finalize-plan",
  schema: finalizePlanPayload,
  maxDuration: 60,
  run: async ({ analysisId, roomId, result }): Promise<{ kind: "ok" }> => {
    await withRoomRevision({
      roomId,
      eventType: "analysis_completed",
      payload: { analysisId },
      write: async (tx) => {
        await tx
          .update(planSnapshots)
          .set({
            status: "complete",
            result,
            completedAt: sql`now()`,
          })
          .where(eq(planSnapshots.analysisId, analysisId))
      },
    })

    await broadcastRoomEvent(roomId, { type: "plan:updated", analysisId })

    logger.info("plan finalized", {
      analysisId,
      candidates: result.candidates.length,
    })
    return { kind: "ok" }
  },
})

/**
 * Mark an analysis failed (status + `analysis_completed` event, one
 * transaction) and nudge the room. Plain helper so the orchestrator can call it
 * from a catch without triggering a task.
 */
export async function markPlanFailed(
  analysisId: string,
  roomId: string,
  error: string
): Promise<void> {
  await withRoomRevision({
    roomId,
    eventType: "analysis_completed",
    payload: { analysisId, failed: true },
    write: async (tx) => {
      await tx
        .update(planSnapshots)
        .set({
          status: "failed",
          error,
          completedAt: sql`now()`,
        })
        .where(eq(planSnapshots.analysisId, analysisId))
    },
  })

  await broadcastRoomEvent(roomId, { type: "plan:updated", analysisId })
}
