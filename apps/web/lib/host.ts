import "server-only"

import { eq, getDb, sql } from "@workspace/db/postgres"
import { roomMembers } from "@workspace/db/schema"

// SERVER-ONLY. Do not import into client components — this touches the database
// directly. `resolveHostId` is the single source of truth for "who is the host"
// so the members API and (in later phases) the decide action agree.

/**
 * The room's effective host: the member with role "host", else the earliest
 * joiner (legacy rooms predate host assignment), tie-broken by lowest
 * participantId. Returns null only for an empty room.
 */
export async function resolveHostId(roomId: string): Promise<string | null> {
  const db = getDb()
  const [row] = await db
    .select({ participantId: roomMembers.participantId })
    .from(roomMembers)
    .where(eq(roomMembers.roomId, roomId))
    // Boolean DESC puts an explicit host row first; then earliest join, then
    // lowest id as a deterministic tie-break.
    .orderBy(
      sql`(${roomMembers.role} = 'host') desc, ${roomMembers.joinedAt} asc, ${roomMembers.participantId} asc`
    )
    .limit(1)
  return row?.participantId ?? null
}
