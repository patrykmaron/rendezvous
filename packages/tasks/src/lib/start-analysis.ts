import { logger, tasks } from "@trigger.dev/sdk"

import { and, desc, eq, getDb, sql } from "@workspace/db/postgres"
import { withRoomRevision } from "@workspace/db/revision"
import {
  participantOrigins,
  planSnapshots,
  roomEvents,
  rooms,
} from "@workspace/db/schema"
// TYPE-ONLY, mirroring the web twin: importing `typeof roomAgentTask` would drag
// room-agent's module graph (OpenAI client, the analysis tasks, the task-side
// Liveblocks broadcaster) into extract-constraints' import graph. The
// dependency-light `.types` module gives `tasks.trigger` its payload/output
// typing without that. See room-agent.types.ts for the full rationale.
import type { RoomAgentTask } from "../trigger/room-agent.types"

import { broadcastRoomEvent } from "./liveblocks"

// TWIN of apps/web/lib/agent-trigger.ts `maybeAutoReplan` + `startAnalysis` —
// keep the guard predicate and the start sequence in sync. Honest reasons this
// is a documented twin rather than a shared import (same shape as the
// liveblocks.ts broadcast twins): (a) the web helper is `import "server-only"`
// and pulls in web's `broadcastRoomEvent`, whose Liveblocks global augmentation
// conflicts with the task-side one; (b) the contracts differ — web's
// `startAnalysis` throws `NeedsOriginsError` for the UI to translate and, for a
// MANUAL re-run, clears a decided room's decision; this background path must
// silently skip on every guard AND must NEVER clear a decision (guard 0 makes a
// decided room unreachable here). A shared home would mean a new package or
// polluting @workspace/db.

// Same window as the web twin's AUTO_REPLAN_COOLDOWN_SECONDS — duplicated
// deliberately (a package must not import an app). Keep the two in sync.
const AUTO_REPLAN_COOLDOWN_SECONDS = 30

// Marks WHY this run exists so the client can label the "Updating…" badge. The
// web twin uses "auto_event_time" for the event-time path; this constraint path
// uses "auto_constraints".
const AUTO_REPLAN_SOURCE = "auto_constraints"

/**
 * Fire-and-forget re-plan of an existing plan after a chat message durably
 * changed the room's constraints (extract-constraints' hook calls this only when
 * `added + removed > 0`). Best-effort: every guard skips with a logged reason,
 * and any failure past the guards is caught by the caller — extraction's result
 * must never be affected.
 *
 * Guards, in order (mirror of the web twin's `maybeAutoReplan`; keep in sync):
 *   0. room is NOT decided (critique §E) — a background chat message must never
 *      blow away a host's lock-in; the host re-runs manually to change a decided
 *      plan. This is why the twin needs no decision-clearing branch: a decided
 *      room is unreachable here.
 *   1. a COMPLETE plan already exists — auto-replan REFINES a plan, it never
 *      creates the first one (constraints gathered pre-plan feed the manual run).
 *   2. no run already in flight (newest-overall snapshot isn't running/pending).
 *   3. >= 2 origins (nothing fair to compute otherwise).
 *   4. no `analysis_requested` event in the last 30s — bounds the auto-replan
 *      rate so a chatty burst can't fan out a run per message.
 *
 * On passing all guards it runs the web-parity start sequence: pin a running
 * snapshot to the current revision, append the `analysis_requested` event
 * (source "auto_constraints" + triggering messageId), fire-and-forget the
 * `room-agent` task, and broadcast `agent:started`.
 */
export async function maybeStartAutoReplan(opts: {
  roomId: string
  participantId: string
  triggerMessageId: string
}): Promise<{ started: boolean; reason?: string }> {
  const { roomId, participantId, triggerMessageId } = opts
  const db = getDb()

  // Guard 0 — decided rooms are off-limits to background replans. Read the
  // revision here too so the running-snapshot insert below pins to it.
  const [room] = await db
    .select({ status: rooms.status, currentRevision: rooms.currentRevision })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1)
  if (!room) return skip("room_not_found")
  if (room.status === "decided") return skip("decided")

  // Guard 1 — a completed plan must already exist (refine, not first-plan).
  const [complete] = await db
    .select({ id: planSnapshots.id })
    .from(planSnapshots)
    .where(
      and(eq(planSnapshots.roomId, roomId), eq(planSnapshots.status, "complete"))
    )
    .limit(1)
  if (!complete) return skip("no_complete_plan")

  // Guard 2 — a run must not already be in flight (never auto-retry a `failed`
  // newest either: that would re-fire a config error like a bad OPENAI_KEY on
  // every chatty message; the completed plan above still stands).
  const [newest] = await db
    .select({ status: planSnapshots.status })
    .from(planSnapshots)
    .where(eq(planSnapshots.roomId, roomId))
    .orderBy(desc(planSnapshots.createdAt))
    .limit(1)
  if (!newest || newest.status === "running" || newest.status === "pending") {
    return skip("run_in_flight")
  }

  // Guard 3 — need at least two origins. Two rows are enough to decide.
  const originRows = await db
    .select({ participantId: participantOrigins.participantId })
    .from(participantOrigins)
    .where(eq(participantOrigins.roomId, roomId))
    .limit(2)
  if (originRows.length < 2) return skip("needs_origins")

  // Guard 4 — 30s cooldown: skip if another analysis was requested inside the
  // window. Bounds the auto-replan rate and closes the two real races (a header
  // "Find fair spots" click landing around the extraction decision; the
  // snapshot-complete-before-run-end window). @workspace/db/postgres exports no
  // `gt`, so the time filter is a raw `sql` fragment.
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
  if (recent) return skip("cooldown")

  // --- Start sequence (mirror of web `startAnalysis`, minus its origins throw
  // and its manual-re-run decision-clearing; guard 0 makes a decided room
  // unreachable so no decision can ever be cleared here). ---

  // Pin the running snapshot to the revision read in guard 0. Plain insert —
  // the snapshot IS the durable "an analysis is in flight" marker.
  const [snapshot] = await db
    .insert(planSnapshots)
    .values({
      roomId,
      roomRevision: room.currentRevision,
      status: "running",
    })
    .returning({ analysisId: planSnapshots.analysisId })
  if (!snapshot) return skip("snapshot_insert_failed")
  const { analysisId } = snapshot

  // Append the analysis_requested event (ADR 0007 revision bump + event). The
  // `source` marker records why this run exists so the client can label the
  // "Rethinking with new preferences…" badge; `triggerMessageId` attributes it
  // to the message whose constraints caused the replan.
  await withRoomRevision({
    roomId,
    eventType: "analysis_requested",
    actorParticipantId: participantId,
    payload: { analysisId, source: AUTO_REPLAN_SOURCE, triggerMessageId },
  })

  // Fire-and-forget the orchestrator (task→task, per the SDK skill: type-only
  // import + `tasks.trigger` awaits only the enqueue). Tagged so the room's
  // realtime token / useRoomAgent subscription can see the run. `source` rides
  // BOTH the trigger-time run metadata (the channel useRoomAgent reads — it
  // skips the payload column) AND the payload (room-agent re-emits it via
  // metadata.set), matching the web twin's metadata mechanism.
  let handle: Awaited<ReturnType<typeof tasks.trigger<RoomAgentTask>>>
  try {
    handle = await tasks.trigger<RoomAgentTask>(
      "room-agent",
      { roomId, analysisId, triggerMessageId, participantId, source: AUTO_REPLAN_SOURCE },
      { tags: [`room:${roomId}`], metadata: { source: AUTO_REPLAN_SOURCE } }
    )
  } catch (err) {
    // Steps above already committed, so the running snapshot is otherwise stuck
    // "running" forever (the /plan route reads the newest snapshot regardless of
    // status). Mark it failed so a retained plan can render "Couldn't update"
    // instead of blanking. Plain update by analysisId — the analysis_requested
    // event already recorded the attempt, so no extra revision event is needed.
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
      logger.warn("maybeStartAutoReplan: mark-failed after trigger error failed", {
        error: String(updateErr),
      })
    }
    throw err
  }

  // Best-effort `agent:started` nudge for parity with the web twin (no client
  // listener today — the UI reacts via the Trigger realtime subscription).
  try {
    await broadcastRoomEvent(roomId, { type: "agent:started", runId: handle.id })
  } catch (err) {
    logger.warn("maybeStartAutoReplan: broadcast agent:started failed", {
      error: String(err),
    })
  }

  return { started: true }
}

function skip(reason: string): { started: false; reason: string } {
  logger.debug("maybeStartAutoReplan: skipped", { reason })
  return { started: false, reason }
}
