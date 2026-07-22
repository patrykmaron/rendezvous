import { eq, getDb } from "@workspace/db/postgres"
import { participants, roomMembers } from "@workspace/db/schema"

import { resolveHostId } from "@/lib/host"
import { UUID_RE } from "@/lib/validate"

// Public (no-auth) member list for a room, used by the join gate to grey out
// taken colours and by the room shell to know who the host is. Exposes only
// display name, colour, and role/isHost — the same non-sensitive presence info
// every member sees anyway; never the participants' sessionToken.

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ roomId: string }> }
): Promise<Response> {
  const { roomId } = await params
  if (!UUID_RE.test(roomId)) {
    return Response.json([], { status: 400 })
  }

  const db = getDb()
  const [members, hostId] = await Promise.all([
    db
      .select({
        participantId: participants.id,
        name: participants.displayName,
        color: participants.color,
        role: roomMembers.role,
      })
      .from(roomMembers)
      .innerJoin(participants, eq(roomMembers.participantId, participants.id))
      .where(eq(roomMembers.roomId, roomId)),
    // Single source of truth for the effective host (explicit role, else the
    // earliest joiner for legacy rooms) — see lib/host.ts.
    resolveHostId(roomId),
  ])

  return Response.json(
    members.map((m) => ({
      ...m,
      isHost: m.participantId === hostId,
    }))
  )
}
