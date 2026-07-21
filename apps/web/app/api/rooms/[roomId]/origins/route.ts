import { eq, getDb } from "@workspace/db/postgres"
import { participantOrigins, participants } from "@workspace/db/schema"

import { bearerToken, requireMember, UnauthorizedError } from "@/lib/auth"
import type { OriginPoint } from "@/lib/types"

// Authenticated origins list for a room. Unlike the public members list, this
// exposes each member's precise start coordinates, so the caller must prove
// membership: the bearer sessionToken comes ONLY via `Authorization: Bearer
// <token>` — never a query-string fallback, so the credential can't leak into
// URLs/logs. Auth failures return 401 without distinguishing which check
// failed (see requireMember).

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
      participantId: participantOrigins.participantId,
      name: participants.displayName,
      color: participants.color,
      lat: participantOrigins.latitude,
      lng: participantOrigins.longitude,
      label: participantOrigins.label,
    })
    .from(participantOrigins)
    .innerJoin(
      participants,
      eq(participantOrigins.participantId, participants.id)
    )
    .where(eq(participantOrigins.roomId, roomId))

  const origins: OriginPoint[] = rows.map((r) => ({
    participantId: r.participantId,
    name: r.name,
    color: r.color,
    lat: r.lat,
    lng: r.lng,
    ...(r.label ? { label: r.label } : {}),
  }))

  return Response.json(origins)
}
