import "server-only"

import { tasks } from "@trigger.dev/sdk"

import { eq, getDb, sql } from "@workspace/db/postgres"
import { withRoomRevision } from "@workspace/db/revision"
import {
  messages,
  participantOrigins,
  planSnapshots,
  rooms,
} from "@workspace/db/schema"
// TYPE-ONLY, from the dependency-light types module (NOT the task impl): gives
// `tasks.trigger` its payload/output typing without dragging the task graph
// into web's compile (see room-agent.types.ts for why).
import type { RoomAgentTask } from "@workspace/tasks/trigger/room-agent.types"
import type { ExtractConstraintsTask } from "@workspace/tasks/trigger/extract-constraints.types"

import { ASSISTANT_AUTHOR } from "@/lib/persona"
import { broadcastRoomEvent } from "@/lib/liveblocks-server"

// SERVER-ONLY. Shared "kick off the room agent" logic, called from both the
// `askAgent` server action (button / explicit request) and `sendMessage`'s
// `@agent` mention path — extracted here so neither duplicates it. This is
// deliberately NOT a "use server" module: these are internal helpers, not
// directly-callable server actions.

/**
 * Thrown when a room has fewer than two start points, so a fair-meeting-place
 * analysis is not yet meaningful. Callers translate this into a typed result
 * (askAgent) or a system chat message (sendMessage's @agent path) rather than
 * surfacing it as an unexpected error.
 */
export class NeedsOriginsError extends Error {
  constructor() {
    super("A room needs at least two start points before the agent can plan.")
    this.name = "NeedsOriginsError"
  }
}

export type StartAnalysisResult = { runId: string; analysisId: string }

/**
 * Starts a room-agent analysis run. In order it:
 *   1. guards that the room has >= 2 origins (else throws NeedsOriginsError);
 *   2. reads the room's current revision and inserts a `plan_snapshots` row in
 *      status "running" pinned to that revision (plain insert — the snapshot is
 *      the durable "an analysis is in flight" marker the plan card reads);
 *   3. appends an `analysis_requested` room event via the ADR 0007 write path;
 *   4. triggers the `room-agent` Trigger.dev task tagged `room:<id>` (the tag
 *      the realtime token / useRoomAgent subscribe by);
 *   5. broadcasts an `agent:started` nudge carrying the run id.
 *
 * Returns the run id + analysis id. Requires TRIGGER_SECRET_KEY for step 4 —
 * without it `tasks.trigger` throws (auth), after steps 1-3 have already run.
 * That throw is caught and marks the just-inserted snapshot "failed" (rather
 * than leaving it stuck "running" forever) before rethrowing, so callers
 * still see the failure and the plan card doesn't get permanently blanked.
 */
export async function startAnalysis(opts: {
  roomId: string
  participantId: string
  triggerMessageId?: string
}): Promise<StartAnalysisResult> {
  const { roomId, participantId, triggerMessageId } = opts
  const db = getDb()

  // 1. Origins guard. Two rows are enough to decide; no need to count them all.
  const originRows = await db
    .select({ participantId: participantOrigins.participantId })
    .from(participantOrigins)
    .where(eq(participantOrigins.roomId, roomId))
    .limit(2)
  if (originRows.length < 2) {
    throw new NeedsOriginsError()
  }

  // 2. Read current revision, then insert the running snapshot pinned to it.
  const [room] = await db
    .select({ currentRevision: rooms.currentRevision })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1)
  if (!room) {
    throw new Error(`startAnalysis: room not found: ${roomId}`)
  }

  const [snapshot] = await db
    .insert(planSnapshots)
    .values({
      roomId,
      roomRevision: room.currentRevision,
      status: "running",
    })
    .returning({ analysisId: planSnapshots.analysisId })
  if (!snapshot) {
    throw new Error("startAnalysis: failed to insert plan snapshot")
  }
  const { analysisId } = snapshot

  // 3. Append the analysis_requested event (ADR 0007 revision bump + event).
  await withRoomRevision({
    roomId,
    eventType: "analysis_requested",
    actorParticipantId: participantId,
    payload: { analysisId },
  })

  // 4. Trigger the orchestrator. Tagged so the room's realtime token (scoped to
  // `room:<id>`) and useRoomAgent's tag subscription can see this run.
  let handle: Awaited<ReturnType<typeof tasks.trigger<RoomAgentTask>>>
  try {
    handle = await tasks.trigger<RoomAgentTask>(
      "room-agent",
      { roomId, analysisId, triggerMessageId, participantId },
      { tags: [`room:${roomId}`] }
    )
  } catch (err) {
    // Steps 1-3 already committed, so the snapshot inserted in step 2 is
    // otherwise stuck in "running" forever — the /plan route returns the
    // newest snapshot regardless of status, and the plan card renders
    // nothing for "running", which would permanently blank a previously
    // complete plan. This is a plain update by analysisId, not a
    // withRoomRevision write: the analysis_requested event from step 3
    // already recorded the attempt, so no additional revision event is
    // needed for this internal bookkeeping.
    try {
      await db
        .update(planSnapshots)
        .set({
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          completedAt: sql`now()`,
        })
        .where(eq(planSnapshots.analysisId, analysisId))
    } catch (updateErr) {
      console.warn(
        "startAnalysis: failed to mark snapshot failed after trigger error",
        updateErr
      )
    }
    throw err
  }

  // 5. Nudge every tab that a run has started (ADR 0012). Best-effort.
  try {
    await broadcastRoomEvent(roomId, {
      type: "agent:started",
      runId: handle.id,
    })
  } catch (err) {
    console.warn("startAnalysis: broadcast agent:started failed", err)
  }

  return { runId: handle.id, analysisId }
}

/**
 * Fire-and-forget kick of the always-listening constraint extractor (ADR 0019)
 * for one chat message. Per-room-serialized via `concurrencyKey: roomId` (see
 * the extract-constraints queue), tagged like the agent run so the room's
 * realtime token can observe it. Callers wrap this in try/catch — extraction
 * must never block or fail the underlying message send.
 */
export async function queueConstraintExtraction(opts: {
  roomId: string
  messageId: string
  participantId: string
  content: string
}): Promise<void> {
  const { roomId, messageId, participantId, content } = opts
  await tasks.trigger<ExtractConstraintsTask>(
    "extract-constraints",
    { roomId, messageId, participantId, content },
    { concurrencyKey: roomId, tags: [`room:${roomId}`] }
  )
}

/**
 * Posts a durable system message from the Rendezvous persona (null author) and
 * nudges every tab to append it. Used by the @agent path when the origins
 * guard fails, so the group gets an inline prompt instead of a silent no-op.
 */
export async function postSystemMessage(
  roomId: string,
  content: string
): Promise<void> {
  const { result } = await withRoomRevision({
    roomId,
    eventType: "message_sent",
    write: async (tx) => {
      const [row] = await tx
        .insert(messages)
        .values({ roomId, participantId: null, role: "system", content })
        .returning({ id: messages.id, createdAt: messages.createdAt })
      return row
    },
  })
  if (!result) return

  try {
    await broadcastRoomEvent(roomId, {
      type: "message:new",
      message: {
        id: result.id,
        roomId,
        participantId: null,
        role: "system",
        content,
        createdAt: result.createdAt.toISOString(),
        author: { name: ASSISTANT_AUTHOR.name, color: ASSISTANT_AUTHOR.color },
        reactions: [],
      },
    })
  } catch (err) {
    console.warn("postSystemMessage: broadcast message:new failed", err)
  }
}
