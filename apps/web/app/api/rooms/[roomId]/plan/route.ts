import { desc, eq, getDb } from "@workspace/db/postgres"
import { planSnapshots } from "@workspace/db/schema"

import { bearerToken, requireMember, UnauthorizedError } from "@/lib/auth"
import type { PlanResult, PlanSnapshotView } from "@/lib/types"

// Authenticated latest-plan endpoint. Membership is proven with the bearer
// sessionToken (Authorization header only — see bearerToken). Returns the
// room's most recent plan snapshot regardless of status, or 204 when the room
// has never been analysed. The card decides what to show per status; running
// snapshots render nothing (agent status UI lands in Task 9).

export async function GET(
  request: Request,
  ctx: { params: Promise<{ roomId: string }> }
): Promise<Response> {
  const { roomId } = await ctx.params

  try {
    await requireMember(bearerToken(request), roomId)
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return new Response("Unauthorized", { status: 401 })
    }
    throw err
  }

  const db = getDb()
  const [snapshot] = await db
    .select({
      status: planSnapshots.status,
      analysisId: planSnapshots.analysisId,
      result: planSnapshots.result,
      createdAt: planSnapshots.createdAt,
    })
    .from(planSnapshots)
    .where(eq(planSnapshots.roomId, roomId))
    .orderBy(desc(planSnapshots.createdAt))
    .limit(1)

  if (!snapshot) {
    return new Response(null, { status: 204 })
  }

  const view: PlanSnapshotView = {
    status: snapshot.status,
    analysisId: snapshot.analysisId,
    result: (snapshot.result as PlanResult | null) ?? null,
    createdAt: snapshot.createdAt.toISOString(),
  }

  return Response.json(view)
}
