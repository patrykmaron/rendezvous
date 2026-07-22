"use server"

import { and, desc, eq, getDb, sql } from "@workspace/db/postgres"
import { withRoomRevision } from "@workspace/db/revision"
import { planSnapshots, rooms, votes } from "@workspace/db/schema"

import { requireMember } from "@/lib/auth"
import { resolveHostId } from "@/lib/host"
import { broadcastRoomEvent } from "@/lib/liveblocks-server"
import type { PlanResult, RoomDecision } from "@/lib/types"
import { UUID_RE } from "@/lib/validate"

// Server actions are public HTTP endpoints (callable directly) — every input is
// validated here, never trusted from the client. requireMember throws
// UnauthorizedError for a missing/invalid session; everything else is ordinary
// business-validation, returned as a typed result the UI reads.

// H3 cells travel as decimal strings (ADR 0008). Accept up to 32 digits (a
// UInt64 is <= 20) — anything else can't be a candidate key.
const H3_RE = /^\d{1,32}$/

export type ToggleVoteResult =
  | { ok: true; candidateH3: string; voterIds: string[]; mine: boolean }
  | { ok: false; error: "decided" | "stale_snapshot" | "invalid" }

/**
 * Toggle THIS member's approval vote on one candidate area of the room's current
 * complete plan. Approval voting: a row = approve, a second toggle deletes it; a
 * member may approve multiple areas (the unique index is per snapshot ×
 * participant × candidate). The vote key is the DISPLAYED plan's snapshot id;
 * votes cascade with their snapshot, so a re-plan resets tallies for free. The
 * post-change tally is broadcast full (ADR 0014) — receivers replace, never
 * increment. Blocked once the room is decided.
 */
export async function toggleVote(
  sessionToken: string,
  roomId: string,
  snapshotId: string,
  candidateH3: string
): Promise<ToggleVoteResult> {
  const { participant } = await requireMember(sessionToken, roomId)

  if (
    typeof snapshotId !== "string" ||
    !UUID_RE.test(snapshotId) ||
    typeof candidateH3 !== "string" ||
    !H3_RE.test(candidateH3)
  ) {
    return { ok: false, error: "invalid" }
  }

  const db = getDb()

  // Room status + newest COMPLETE snapshot (the only votable one). A vote for
  // anything but the current complete snapshot is stale.
  const [[room], [snapshot]] = await Promise.all([
    db
      .select({ status: rooms.status })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1),
    db
      .select({ id: planSnapshots.id, result: planSnapshots.result })
      .from(planSnapshots)
      .where(
        and(
          eq(planSnapshots.roomId, roomId),
          eq(planSnapshots.status, "complete")
        )
      )
      .orderBy(desc(planSnapshots.createdAt))
      .limit(1),
  ])

  if (!snapshot || snapshot.id !== snapshotId) {
    return { ok: false, error: "stale_snapshot" }
  }
  // Once locked in, voting is closed (the decision supersedes the tally).
  if (room?.status === "decided") {
    return { ok: false, error: "decided" }
  }
  const result = (snapshot.result as PlanResult | null) ?? null
  const known = result?.candidates.some((c) => c.h3 === candidateH3) ?? false
  if (!known) {
    return { ok: false, error: "invalid" }
  }

  // Authoritative toggle inside the revision tx. The event payload is
  // action-free ({snapshotId, candidateH3}) — withRoomRevision takes the
  // payload before the write runs, and the vote log fully reconstructs state
  // from row existence anyway; `action` rides only the broadcast + return.
  const { result: action } = await withRoomRevision({
    roomId,
    eventType: "vote_cast",
    actorParticipantId: participant.id,
    payload: { snapshotId, candidateH3 },
    write: async (tx) => {
      const deleted = await tx
        .delete(votes)
        .where(
          and(
            eq(votes.planSnapshotId, snapshotId),
            eq(votes.participantId, participant.id),
            eq(votes.candidateH3, candidateH3)
          )
        )
        .returning({ id: votes.id })
      if (deleted.length > 0) return "removed" as const
      await tx.insert(votes).values({
        roomId,
        participantId: participant.id,
        planSnapshotId: snapshotId,
        candidateH3,
        value: 1,
      })
      return "added" as const
    },
  })

  // Full post-change tally for the candidate (drives the vote:update replace).
  const voterRows = await db
    .select({ participantId: votes.participantId })
    .from(votes)
    .where(
      and(
        eq(votes.planSnapshotId, snapshotId),
        eq(votes.candidateH3, candidateH3)
      )
    )
  const voterIds = voterRows.map((r) => r.participantId)
  const mine = action === "added"

  try {
    await broadcastRoomEvent(roomId, {
      type: "vote:update",
      snapshotId,
      candidateH3,
      voterIds,
      action: action ?? "added",
      participantId: participant.id,
    })
  } catch (err) {
    console.warn("toggleVote: broadcast vote:update failed", err)
  }

  return { ok: true, candidateH3, voterIds, mine }
}

export type DecidePlanResult =
  | { ok: true; decision: RoomDecision }
  | {
      ok: false
      error:
        | "not_host"
        | "already_decided"
        | "replanning"
        | "stale_snapshot"
        | "invalid"
    }

/**
 * Host-only: lock in one candidate area of the current complete plan as the
 * room's decision. Writes rooms.settings.decided (a denormalised RoomDecision),
 * status "decided", and decidedSnapshotId — all in one withRoomRevision with a
 * plan_decided event — then broadcasts decided:update. There is no undo action:
 * a manual re-run (startAnalysis) clears the decision, since it's pinned to a
 * snapshot a new run supersedes.
 */
export async function decidePlan(
  sessionToken: string,
  roomId: string,
  snapshotId: string,
  candidateH3: string
): Promise<DecidePlanResult> {
  const { participant } = await requireMember(sessionToken, roomId)

  if (
    typeof snapshotId !== "string" ||
    !UUID_RE.test(snapshotId) ||
    typeof candidateH3 !== "string" ||
    !H3_RE.test(candidateH3)
  ) {
    return { ok: false, error: "invalid" }
  }

  // Only the effective host may lock in (see lib/host.ts).
  const hostId = await resolveHostId(roomId)
  if (hostId !== participant.id) {
    return { ok: false, error: "not_host" }
  }

  const db = getDb()
  const [[room], [snapshot], [newestOverall]] = await Promise.all([
    db
      .select({ status: rooms.status })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1),
    db
      .select({ id: planSnapshots.id, result: planSnapshots.result })
      .from(planSnapshots)
      .where(
        and(
          eq(planSnapshots.roomId, roomId),
          eq(planSnapshots.status, "complete")
        )
      )
      .orderBy(desc(planSnapshots.createdAt))
      .limit(1),
    // Newest-overall snapshot — a re-plan in flight (running/pending) must block
    // a lock-in even for direct-API callers the UI hide doesn't cover: deciding
    // on a snapshot about to be superseded would strand the decision.
    db
      .select({ status: planSnapshots.status })
      .from(planSnapshots)
      .where(eq(planSnapshots.roomId, roomId))
      .orderBy(desc(planSnapshots.createdAt))
      .limit(1),
  ])

  if (room?.status === "decided") {
    return { ok: false, error: "already_decided" }
  }
  if (
    newestOverall &&
    (newestOverall.status === "running" || newestOverall.status === "pending")
  ) {
    return { ok: false, error: "replanning" }
  }
  if (!snapshot || snapshot.id !== snapshotId) {
    return { ok: false, error: "stale_snapshot" }
  }
  const result = (snapshot.result as PlanResult | null) ?? null
  const candidate = result?.candidates.find((c) => c.h3 === candidateH3)
  if (!candidate) {
    return { ok: false, error: "invalid" }
  }

  const decision: RoomDecision = {
    snapshotId,
    candidateH3,
    candidateName: candidate.name,
    decidedBy: { participantId: participant.id, name: participant.displayName },
    decidedAt: new Date().toISOString(),
  }

  await withRoomRevision({
    roomId,
    eventType: "plan_decided",
    actorParticipantId: participant.id,
    payload: { snapshotId, candidateH3 },
    write: async (tx) => {
      await tx
        .update(rooms)
        .set({
          status: "decided",
          decidedSnapshotId: snapshotId,
          // jsonb merge (not overwrite) so settings.eventAt survives.
          settings: sql`${rooms.settings} || ${JSON.stringify({ decided: decision })}::jsonb`,
        })
        .where(eq(rooms.id, roomId))
    },
  })

  try {
    await broadcastRoomEvent(roomId, { type: "decided:update", decision })
  } catch (err) {
    console.warn("decidePlan: broadcast decided:update failed", err)
  }

  return { ok: true, decision }
}
