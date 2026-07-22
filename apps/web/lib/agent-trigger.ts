import "server-only"

import { tasks } from "@trigger.dev/sdk"

import { and, desc, eq, getDb, sql } from "@workspace/db/postgres"
import { withRoomRevision } from "@workspace/db/revision"
import {
  messages,
  participantOrigins,
  planSnapshots,
  roomEvents,
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
 *
 * `source` (e.g. "auto_event_time") tags WHY the run exists — it rides both the
 * analysis_requested event payload and the run's trigger-time metadata, which is
 * the only channel useRoomAgent can read (it skips the payload column). A manual
 * re-run (no source) in a DECIDED room clears the decision in the same
 * withRoomRevision: the decision is pinned to a snapshot, so a new one
 * invalidates it (status → "gathering", decidedSnapshotId null, settings.decided
 * dropped, decided:update null broadcast).
 */
export async function startAnalysis(opts: {
  roomId: string
  participantId: string
  triggerMessageId?: string
  source?: string
}): Promise<StartAnalysisResult> {
  const { roomId, participantId, triggerMessageId, source } = opts
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

  // 2. Read current revision (+ status, to clear a decision on a manual
  // re-run), then insert the running snapshot pinned to it.
  const [room] = await db
    .select({ currentRevision: rooms.currentRevision, status: rooms.status })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1)
  if (!room) {
    throw new Error(`startAnalysis: room not found: ${roomId}`)
  }
  const wasDecided = room.status === "decided"

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
  // A manual re-run in a decided room clears the decision in the SAME tx (the
  // decision is pinned to a snapshot a new run supersedes). `source` records
  // why this run exists so a later phase can label the "Updating…" badge.
  await withRoomRevision({
    roomId,
    eventType: "analysis_requested",
    actorParticipantId: participantId,
    payload: {
      analysisId,
      ...(source ? { source } : {}),
      ...(wasDecided ? { clearedDecision: true } : {}),
    },
    ...(wasDecided
      ? {
          write: async (tx) => {
            await tx
              .update(rooms)
              .set({
                status: "gathering",
                decidedSnapshotId: null,
                settings: sql`${rooms.settings} - 'decided'`,
              })
              .where(eq(rooms.id, roomId))
          },
        }
      : {}),
  })

  // 4. Trigger the orchestrator. Tagged so the room's realtime token (scoped to
  // `room:<id>`) and useRoomAgent's tag subscription can see this run.
  let handle: Awaited<ReturnType<typeof tasks.trigger<RoomAgentTask>>>
  try {
    handle = await tasks.trigger<RoomAgentTask>(
      "room-agent",
      { roomId, analysisId, triggerMessageId, participantId },
      {
        tags: [`room:${roomId}`],
        // metadata.source is the ONLY channel useRoomAgent can read the reason
        // from (it skips the payload column); merges per-key, so status updates
        // inside the run don't clobber it.
        ...(source ? { metadata: { source } } : {}),
      }
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

  // If this re-run cleared a decision (step 3), tell every tab to drop its
  // decided banner / re-enable voting. Best-effort, same as agent:started.
  if (wasDecided) {
    try {
      await broadcastRoomEvent(roomId, { type: "decided:update", decision: null })
    } catch (err) {
      console.warn("startAnalysis: broadcast decided:update(null) failed", err)
    }
  }

  return { runId: handle.id, analysisId }
}

const AUTO_REPLAN_COOLDOWN_SECONDS = 30

/**
 * Fire-and-forget re-cost of an existing plan after a room-level input changed
 * (today: the event time). Called AFTER the triggering write commits; swallows
 * everything so it can never surface to the caller. Guards, in order (mirror of
 * the tasks-side auto-replan twin in a later phase — keep the predicate in
 * sync):
 *   0. room is NOT decided — a background action must never blow away a host's
 *      lock-in (the host re-runs manually to change a decided plan);
 *   1. >= 2 origins (else there's nothing fair to compute — and startAnalysis
 *      would throw NeedsOriginsError anyway);
 *   2. a COMPLETE plan already exists AND no run is in flight (newest snapshot
 *      isn't running/pending) — "re-plan", not "first plan" (that's manual);
 *   3. no analysis_requested event in the last 30s — bounds the auto-replan
 *      rate so rapid edits can't fan out a run per keystroke.
 * On passing all guards it delegates to startAnalysis with source
 * "auto_event_time".
 */
export async function maybeAutoReplan(
  roomId: string,
  participantId: string
): Promise<void> {
  try {
    const db = getDb()

    // Guard 0 — decided rooms are off-limits to background replans.
    const [room] = await db
      .select({ status: rooms.status })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1)
    if (!room || room.status === "decided") return

    // Guard 1 — need at least two origins.
    const originRows = await db
      .select({ participantId: participantOrigins.participantId })
      .from(participantOrigins)
      .where(eq(participantOrigins.roomId, roomId))
      .limit(2)
    if (originRows.length < 2) return

    // Guard 2 — a run must not already be in flight, and a complete plan must
    // exist to re-cost.
    const [newest] = await db
      .select({ status: planSnapshots.status })
      .from(planSnapshots)
      .where(eq(planSnapshots.roomId, roomId))
      .orderBy(desc(planSnapshots.createdAt))
      .limit(1)
    if (!newest || newest.status === "running" || newest.status === "pending") {
      return
    }
    const [complete] = await db
      .select({ id: planSnapshots.id })
      .from(planSnapshots)
      .where(
        and(
          eq(planSnapshots.roomId, roomId),
          eq(planSnapshots.status, "complete")
        )
      )
      .limit(1)
    if (!complete) return

    // Guard 3 — 30s cooldown: skip if another analysis was requested inside the
    // window (bounds the auto-replan rate).
    const cutoff = new Date(Date.now() - AUTO_REPLAN_COOLDOWN_SECONDS * 1000)
    const [recent] = await db
      .select({ id: roomEvents.id })
      .from(roomEvents)
      .where(
        and(
          eq(roomEvents.roomId, roomId),
          eq(roomEvents.eventType, "analysis_requested"),
          sql`${roomEvents.createdAt} > ${cutoff}`
        )
      )
      .limit(1)
    if (recent) return

    await startAnalysis({ roomId, participantId, source: "auto_event_time" })
  } catch (err) {
    // Best-effort by design — a skipped/failed auto-replan must not surface.
    console.warn("maybeAutoReplan: skipped or failed", err)
  }
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
  // Extraction runs SHARE the `room:<id>` tag with the room-agent orchestrator
  // so the room's scoped realtime token can observe them in the dashboard.
  // Harmless to the agent UI: useRoomAgent filters the tag subscription down to
  // `taskIdentifier === "room-agent"`, so these runs never drive its state.
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
