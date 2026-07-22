import { asc, eq, getDb } from "@workspace/db/postgres"
import { constraints, participants } from "@workspace/db/schema"

import { bearerToken, requireMember, UnauthorizedError } from "@/lib/auth"
import { ASSISTANT_AUTHOR } from "@/lib/persona"
import { asConstraintKind, type ConstraintView } from "@/lib/types"

// Authenticated planning constraints for a room (ADR 0019), for the chat's
// chip strip. Membership is proven with the bearer sessionToken (Authorization
// header only — see bearerToken). Returns all constraints in chronological
// (ascending) order, each with a human `summary` and, for personal rows, its
// author's name/colour (LEFT-joined; room-wide rows have a null participantId).

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

  const rows = await db
    .select({
      id: constraints.id,
      participantId: constraints.participantId,
      kind: constraints.kind,
      isHard: constraints.isHard,
      payload: constraints.payload,
      createdAt: constraints.createdAt,
      authorName: participants.displayName,
      authorColor: participants.color,
    })
    .from(constraints)
    .leftJoin(participants, eq(constraints.participantId, participants.id))
    .where(eq(constraints.roomId, roomId))
    .orderBy(asc(constraints.createdAt))

  const result: ConstraintView[] = rows.map((r) => {
    const payload = (r.payload ?? {}) as Record<string, unknown>
    const summary =
      typeof payload.summary === "string" && payload.summary.length > 0
        ? payload.summary
        : r.kind
    const view: ConstraintView = {
      id: r.id,
      roomId,
      participantId: r.participantId,
      kind: asConstraintKind(r.kind),
      isHard: r.isHard,
      summary,
      createdAt: r.createdAt.toISOString(),
    }
    if (r.participantId && r.authorName) {
      view.author = {
        name: r.authorName,
        color: r.authorColor ?? ASSISTANT_AUTHOR.color,
      }
    }
    return view
  })

  return Response.json(result)
}
