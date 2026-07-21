import { eq, getDb } from "@workspace/db/postgres"
import { participants, roomMembers } from "@workspace/db/schema"

import { UUID_RE } from "@/lib/validate"

// Public (no-auth) member list for a room, used by the join gate to grey out
// colours that are already taken. Exposes only display name + colour — the
// same non-sensitive presence info every member sees anyway; never the
// participants' sessionToken.

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ roomId: string }> }
): Promise<Response> {
  const { roomId } = await params
  if (!UUID_RE.test(roomId)) {
    return Response.json([], { status: 400 })
  }

  const db = getDb()
  const members = await db
    .select({
      participantId: participants.id,
      name: participants.displayName,
      color: participants.color,
    })
    .from(roomMembers)
    .innerJoin(participants, eq(roomMembers.participantId, participants.id))
    .where(eq(roomMembers.roomId, roomId))

  return Response.json(members)
}
