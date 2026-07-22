import { and, desc, eq, getDb } from "@workspace/db/postgres"
import { planSnapshots, rooms, votes } from "@workspace/db/schema"

import { bearerToken, requireMember, UnauthorizedError } from "@/lib/auth"
import type {
  PlanResponse,
  PlanResult,
  PlanSnapshotView,
  RoomDecision,
  VoteTally,
} from "@/lib/types"

// Authenticated plan endpoint. Membership is proven with the bearer
// sessionToken (Authorization header only — see bearerToken). Always 200 with a
// PlanResponse; `plan: null` is the empty state (the 204 is gone).
//
// Retention rule (fixes the plan-vanishes-during-rerun bug): `plan` is the
// newest COMPLETE snapshot, so a re-plan in flight keeps the previous plan on
// screen. `replanning` = the newest-overall snapshot is running/pending;
// `updateFailed` = it failed while a complete plan is still shown. Only when no
// snapshot was ever complete does `plan` fall back to the newest-overall row
// (the first-run running/failed/empty cases, which the card renders as before).

// Defensively narrow rooms.settings.decided (jsonb) to a RoomDecision.
function asDecision(value: unknown): RoomDecision | null {
  if (!value || typeof value !== "object") return null
  const d = value as Record<string, unknown>
  const by = d.decidedBy as Record<string, unknown> | undefined
  if (
    typeof d.snapshotId === "string" &&
    typeof d.candidateH3 === "string" &&
    typeof d.candidateName === "string" &&
    typeof d.decidedAt === "string" &&
    // typeof null === "object", so an explicit `by !== null` is required — a
    // null decidedBy would otherwise slip the guard and throw on by.participantId.
    by !== null &&
    typeof by === "object" &&
    typeof by.participantId === "string" &&
    typeof by.name === "string"
  ) {
    return value as RoomDecision
  }
  return null
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ roomId: string }> }
): Promise<Response> {
  const { roomId } = await ctx.params

  let callerId: string
  try {
    const { participant } = await requireMember(bearerToken(request), roomId)
    callerId = participant.id
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return new Response("Unauthorized", { status: 401 })
    }
    throw err
  }

  const db = getDb()

  const snapshotCols = {
    id: planSnapshots.id,
    status: planSnapshots.status,
    analysisId: planSnapshots.analysisId,
    result: planSnapshots.result,
    createdAt: planSnapshots.createdAt,
  }

  // Newest-overall snapshot (drives replanning/updateFailed).
  const [newest] = await db
    .select(snapshotCols)
    .from(planSnapshots)
    .where(eq(planSnapshots.roomId, roomId))
    .orderBy(desc(planSnapshots.createdAt))
    .limit(1)

  // Newest COMPLETE snapshot (the retained plan). Skip the extra query when the
  // newest-overall row is itself complete.
  let complete: typeof newest | undefined =
    newest && newest.status === "complete" ? newest : undefined
  if (newest && !complete) {
    ;[complete] = await db
      .select(snapshotCols)
      .from(planSnapshots)
      .where(
        and(
          eq(planSnapshots.roomId, roomId),
          eq(planSnapshots.status, "complete")
        )
      )
      .orderBy(desc(planSnapshots.createdAt))
      .limit(1)
  }

  const planRow = complete ?? newest ?? null
  const replanning =
    !!newest && (newest.status === "running" || newest.status === "pending")
  const updateFailed = !!newest && newest.status === "failed" && !!complete

  const plan: PlanSnapshotView | null = planRow
    ? {
        id: planRow.id,
        status: planRow.status,
        analysisId: planRow.analysisId,
        result: (planRow.result as PlanResult | null) ?? null,
        createdAt: planRow.createdAt.toISOString(),
      }
    : null

  // Approval tallies for the DISPLAYED plan (votes cascade with their snapshot,
  // so a superseded plan's votes never leak into a newer one).
  let voteTallies: VoteTally[] = []
  const myVotes: string[] = []
  if (plan) {
    const rows = await db
      .select({
        participantId: votes.participantId,
        candidateH3: votes.candidateH3,
      })
      .from(votes)
      .where(eq(votes.planSnapshotId, plan.id))
    const byCandidate = new Map<string, string[]>()
    for (const r of rows) {
      const list = byCandidate.get(r.candidateH3)
      if (list) list.push(r.participantId)
      else byCandidate.set(r.candidateH3, [r.participantId])
      if (r.participantId === callerId) myVotes.push(r.candidateH3)
    }
    voteTallies = Array.from(byCandidate, ([candidateH3, voterIds]) => ({
      candidateH3,
      voterIds,
    }))
  }

  const [room] = await db
    .select({ settings: rooms.settings })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1)
  const decision = asDecision(room?.settings?.decided)

  const response: PlanResponse = {
    plan,
    replanning,
    updateFailed,
    votes: voteTallies,
    myVotes,
    decision,
  }

  return Response.json(response)
}
