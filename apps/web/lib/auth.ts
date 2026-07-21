import { and, eq, getDb } from "@workspace/db/postgres"
import {
  participants,
  roomMembers,
  type Participant,
  type RoomMember,
} from "@workspace/db/schema"

// SERVER-ONLY. Do not import into client components — this touches the
// database directly. `participants.sessionToken` is the bearer credential
// (see apps/web/lib/session.ts for how the client stores/sends it); there
// are no cookies and no passwords in this app.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message)
    this.name = "UnauthorizedError"
  }
}

/**
 * Resolves a bearer `sessionToken` to a participant and confirms they are a
 * member of `roomId`. Every server action / route handler that acts on
 * behalf of a participant must call this first. Throws `UnauthorizedError`
 * for any failure mode (malformed input, unknown token, not a member) —
 * callers should not distinguish these cases to a client, to avoid leaking
 * which part of the check failed.
 */
export async function requireMember(
  sessionToken: string,
  roomId: string
): Promise<{ participant: Participant; membership: RoomMember }> {
  if (
    typeof sessionToken !== "string" ||
    typeof roomId !== "string" ||
    !UUID_RE.test(sessionToken) ||
    !UUID_RE.test(roomId)
  ) {
    throw new UnauthorizedError()
  }

  const db = getDb()

  const [participant] = await db
    .select()
    .from(participants)
    .where(eq(participants.sessionToken, sessionToken))
    .limit(1)
  if (!participant) {
    throw new UnauthorizedError()
  }

  const [membership] = await db
    .select()
    .from(roomMembers)
    .where(
      and(
        eq(roomMembers.roomId, roomId),
        eq(roomMembers.participantId, participant.id)
      )
    )
    .limit(1)
  if (!membership) {
    throw new UnauthorizedError()
  }

  return { participant, membership }
}
