import { eq, sql } from "drizzle-orm"

import { getDb, type Db } from "./client"
import { roomEvents, rooms, type RoomEventType } from "./schema"

// The drizzle transaction handle, derived from the db's transaction callback so
// it stays in lockstep with the client's schema.
type RoomTx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export interface WithRoomRevisionOptions<T> {
  roomId: string
  eventType: RoomEventType
  actorParticipantId?: string | null
  payload?: Record<string, unknown>
  // Runs inside the SAME transaction, after the revision bump and before the
  // event insert. Receives the tx handle and the freshly bumped revision, so
  // any durable write it performs shares the room-row lock and the event row.
  write?: (tx: RoomTx, revision: number) => Promise<T>
}

/**
 * The ADR 0007 write path, implemented once for both web server actions and
 * Trigger tasks. In a single transaction it:
 *
 *   1. bumps `rooms.current_revision` via UPDATE ... RETURNING — the row-lock
 *      that serializes concurrent writers (never read-then-write the revision);
 *   2. runs the optional `write` against the same tx, at the new revision;
 *   3. appends a `room_events` row (append-only — no updates, no deletes).
 *
 * Throws if the room does not exist. Returns the new revision and, when a
 * `write` was supplied, its result.
 */
export async function withRoomRevision<T>(
  opts: WithRoomRevisionOptions<T>
): Promise<{ revision: number; result: T | undefined }> {
  return getDb().transaction(async (tx) => {
    const [bumped] = await tx
      .update(rooms)
      .set({
        currentRevision: sql`${rooms.currentRevision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(rooms.id, opts.roomId))
      .returning({ currentRevision: rooms.currentRevision })
    if (!bumped) {
      throw new Error(`withRoomRevision: room not found: ${opts.roomId}`)
    }
    const revision = bumped.currentRevision

    const result = await opts.write?.(tx, revision)

    await tx.insert(roomEvents).values({
      roomId: opts.roomId,
      revision,
      eventType: opts.eventType,
      actorParticipantId: opts.actorParticipantId ?? null,
      payload: opts.payload ?? {},
    })

    return { revision, result }
  })
}
