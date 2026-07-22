"use server"

import { and, eq, getDb } from "@workspace/db/postgres"
import { withRoomRevision } from "@workspace/db/revision"
import { constraints } from "@workspace/db/schema"

import { requireMember } from "@/lib/auth"
import { broadcastRoomEvent } from "@/lib/liveblocks-server"
import { asConstraintKind, type ConstraintView } from "@/lib/types"
import { UUID_RE } from "@/lib/validate"

// Server actions are public HTTP endpoints (callable directly, not just from
// the chip's X button) — every input is validated here. requireMember throws
// UnauthorizedError for a missing/invalid session; ordinary business failures
// (bad id, not found, not permitted) return a typed result (mirrors origin.ts).

export type RemoveConstraintResult = { ok: true } | { ok: false; error: string }

/**
 * Deletes a constraint the caller is allowed to remove: their own personal
 * constraint, or any room-wide one. The delete rides the ADR 0007 write path
 * (revision bump + `constraint_removed` event in one transaction); a
 * `constraint:update`/removed nudge is broadcast after commit so every tab
 * drops the chip (deletion is broadcast-driven — no optimistic local removal).
 */
export async function removeConstraint(
  sessionToken: string,
  roomId: string,
  constraintId: string
): Promise<RemoveConstraintResult> {
  const { participant } = await requireMember(sessionToken, roomId)

  if (!UUID_RE.test(constraintId)) {
    return { ok: false, error: "Invalid constraint id." }
  }

  const db = getDb()

  // Scope the lookup to the room, or a member of room A could delete room B's
  // constraint by id.
  const [row] = await db
    .select({
      id: constraints.id,
      participantId: constraints.participantId,
      kind: constraints.kind,
      isHard: constraints.isHard,
      payload: constraints.payload,
      createdAt: constraints.createdAt,
    })
    .from(constraints)
    .where(and(eq(constraints.id, constraintId), eq(constraints.roomId, roomId)))
    .limit(1)
  if (!row) {
    return { ok: false, error: "Constraint not found." }
  }

  // Permission: your own personal row, or any room-wide (null-participant) row.
  if (row.participantId !== null && row.participantId !== participant.id) {
    return { ok: false, error: "You can only remove your own constraints." }
  }

  const payload = (row.payload ?? {}) as Record<string, unknown>
  const summary =
    typeof payload.summary === "string" ? payload.summary : row.kind

  await withRoomRevision({
    roomId,
    eventType: "constraint_removed",
    actorParticipantId: participant.id,
    payload: {
      constraintId: row.id,
      participantId: row.participantId,
      kind: row.kind,
      summary,
      removedBy: participant.id,
    },
    write: async (tx) => {
      await tx.delete(constraints).where(eq(constraints.id, row.id))
    },
  })

  // Nudge every tab to drop the chip (ADR 0012). Best-effort — a realtime
  // hiccup must not fail the durable delete.
  const view: ConstraintView = {
    id: row.id,
    roomId,
    participantId: row.participantId,
    kind: asConstraintKind(row.kind),
    isHard: row.isHard,
    summary,
    createdAt: row.createdAt.toISOString(),
  }
  try {
    await broadcastRoomEvent(roomId, {
      type: "constraint:update",
      action: "removed",
      constraint: view,
    })
  } catch (err) {
    console.warn("removeConstraint: broadcast constraint:update failed", err)
  }

  return { ok: true }
}
