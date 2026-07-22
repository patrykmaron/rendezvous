"use server"

import { redirect } from "next/navigation"

import { eq, getDb } from "@workspace/db/postgres"
import { withRoomRevision } from "@workspace/db/revision"
import { participants, roomMembers, rooms } from "@workspace/db/schema"

import { requireMember } from "@/lib/auth"
import { PARTICIPANT_COLORS } from "@/lib/colors"
import { broadcastRoomEvent } from "@/lib/liveblocks-server"
import { UUID_RE } from "@/lib/validate"

// Server actions are public HTTP endpoints (callable directly, not just from
// the rendered form) — every input is validated here, never trusted from the
// client.

// Thrown from inside a withRoomRevision `write` callback when the in-tx
// uniqueness check (the race-free authority — see joinRoom/changeColor)
// finds the colour already claimed. Rolls back the transaction; callers
// catch it and translate it back to the ordinary typed error result.
class ColorTakenError extends Error {
  constructor() {
    super("That colour is already taken in this room.")
    this.name = "ColorTakenError"
  }
}

const ROOM_NAME_MIN = 1
const ROOM_NAME_MAX = 80
const USERNAME_MIN = 1
const USERNAME_MAX = 24

export type JoinRoomResult =
  | {
      ok: true
      participantId: string
      sessionToken: string
      name: string
      color: string
    }
  | { ok: false; error: string }

export type ChangeColorResult =
  | { ok: true; color: string }
  | { ok: false; error: string }

function paletteEntryFor(colorHex: string) {
  return PARTICIPANT_COLORS.find((c) => c.hex === colorHex)
}

/**
 * Creates a room and redirects to it. room_created is always revision 1:
 * the room row is inserted first (so it exists for withRoomRevision to bump),
 * then withRoomRevision appends the room_created event in its own
 * transaction. No participant/session is created here — the creator joins
 * like anyone else once they land on the room page.
 */
export async function createRoom(name: string) {
  if (typeof name !== "string") {
    throw new Error("Room name is required.")
  }
  const trimmed = name.trim()
  if (trimmed.length < ROOM_NAME_MIN || trimmed.length > ROOM_NAME_MAX) {
    throw new Error(
      `Room name must be between ${ROOM_NAME_MIN} and ${ROOM_NAME_MAX} characters.`
    )
  }

  const db = getDb()
  const [room] = await db
    .insert(rooms)
    .values({ name: trimmed })
    .returning({ id: rooms.id })
  if (!room) {
    throw new Error("Failed to create room.")
  }

  await withRoomRevision({
    roomId: room.id,
    eventType: "room_created",
    payload: { name: trimmed },
  })

  redirect(`/room/${room.id}`)
}

/**
 * Joins an existing room under a chosen display name + colour. Colour
 * uniqueness is a live property of the room's current membership (not
 * something the client can fully validate itself), so unlike malformed-input
 * failures below, it is returned as a typed result rather than thrown, so
 * the join UI can show it inline.
 */
export async function joinRoom(
  roomId: string,
  username: string,
  colorHex: string
): Promise<JoinRoomResult> {
  if (typeof roomId !== "string" || !UUID_RE.test(roomId)) {
    return { ok: false, error: "Invalid room." }
  }
  if (typeof username !== "string") {
    return { ok: false, error: "Name is required." }
  }
  const name = username.trim()
  if (name.length < USERNAME_MIN || name.length > USERNAME_MAX) {
    return {
      ok: false,
      error: `Name must be between ${USERNAME_MIN} and ${USERNAME_MAX} characters.`,
    }
  }
  const paletteEntry =
    typeof colorHex === "string" ? paletteEntryFor(colorHex) : undefined
  if (!paletteEntry) {
    return { ok: false, error: "Choose a colour from the palette." }
  }

  const db = getDb()

  const [room] = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1)
  if (!room) {
    return { ok: false, error: "Room not found." }
  }

  // Cheap fast-path check only (fails fast for the common case, better UX) —
  // NOT race-free by itself, since it runs before withRoomRevision opens its
  // transaction. The authoritative check is inside the write callback below.
  const memberColors = await db
    .select({ color: participants.color })
    .from(roomMembers)
    .innerJoin(participants, eq(roomMembers.participantId, participants.id))
    .where(eq(roomMembers.roomId, roomId))
  if (memberColors.some((row) => row.color === paletteEntry.hex)) {
    return { ok: false, error: "That colour is already taken in this room." }
  }

  // Generated up front (rather than left to the column default) so it can
  // double as room_events.actor_participant_id for the member_joined event
  // inserted after the write callback returns.
  const participantId = crypto.randomUUID()

  try {
    const { result: participant } = await withRoomRevision({
      roomId,
      eventType: "member_joined",
      actorParticipantId: participantId,
      payload: { participantId, name, color: paletteEntry.hex },
      write: async (tx) => {
        // Authoritative uniqueness check: runs inside the same transaction,
        // after withRoomRevision's UPDATE ... RETURNING has row-locked
        // `rooms` for this roomId, which serializes all concurrent
        // same-room writers — so this SELECT can no longer race with
        // another writer's insert.
        const memberColorsInTx = await tx
          .select({ color: participants.color })
          .from(roomMembers)
          .innerJoin(
            participants,
            eq(roomMembers.participantId, participants.id)
          )
          .where(eq(roomMembers.roomId, roomId))
        if (memberColorsInTx.some((row) => row.color === paletteEntry.hex)) {
          throw new ColorTakenError()
        }

        const [inserted] = await tx
          .insert(participants)
          .values({
            id: participantId,
            displayName: name,
            color: paletteEntry.hex,
          })
          .returning()
        if (!inserted) {
          throw new Error("joinRoom: failed to insert participant")
        }
        // The first member to join is the host. Race-free: withRoomRevision's
        // UPDATE ... RETURNING has row-locked this room, serializing concurrent
        // joiners, so at most one sees an empty membership. Existing rooms
        // predate this and have no host row — resolveHostId falls back to the
        // earliest joiner for them (see lib/host.ts).
        const [existingMember] = await tx
          .select({ participantId: roomMembers.participantId })
          .from(roomMembers)
          .where(eq(roomMembers.roomId, roomId))
          .limit(1)
        await tx.insert(roomMembers).values({
          roomId,
          participantId,
          ...(existingMember ? {} : { role: "host" as const }),
        })
        return inserted
      },
    })
    if (!participant) {
      return { ok: false, error: "Failed to join room." }
    }

    // Nudge existing members to refetch the roster (ADR 0012). Fired after the
    // transaction has committed; a realtime failure must never fail the join,
    // so it's best-effort.
    try {
      await broadcastRoomEvent(roomId, {
        type: "member:update",
        kind: "joined",
        participantId: participant.id,
        name: participant.displayName,
        color: participant.color,
      })
    } catch (err) {
      console.warn("joinRoom: broadcast member:update failed", err)
    }

    return {
      ok: true,
      participantId: participant.id,
      sessionToken: participant.sessionToken,
      name: participant.displayName,
      color: participant.color,
    }
  } catch (err) {
    if (err instanceof ColorTakenError) {
      return { ok: false, error: err.message }
    }
    throw err
  }
}

/**
 * Changes the caller's colour. requireMember throws UnauthorizedError for a
 * missing/invalid session — that's an exceptional auth failure, distinct
 * from the ordinary "colour already taken" business-validation result below.
 */
export async function changeColor(
  sessionToken: string,
  roomId: string,
  colorHex: string
): Promise<ChangeColorResult> {
  const { participant } = await requireMember(sessionToken, roomId)

  const paletteEntry =
    typeof colorHex === "string" ? paletteEntryFor(colorHex) : undefined
  if (!paletteEntry) {
    return { ok: false, error: "Choose a colour from the palette." }
  }

  // Cheap fast-path check only — see joinRoom for why this is not race-free
  // by itself and the in-tx check below is the authority.
  const db = getDb()
  const memberColors = await db
    .select({
      participantId: roomMembers.participantId,
      color: participants.color,
    })
    .from(roomMembers)
    .innerJoin(participants, eq(roomMembers.participantId, participants.id))
    .where(eq(roomMembers.roomId, roomId))
  const takenByOther = memberColors.some(
    (row) =>
      row.color === paletteEntry.hex && row.participantId !== participant.id
  )
  if (takenByOther) {
    return { ok: false, error: "That colour is already taken in this room." }
  }

  try {
    await withRoomRevision({
      roomId,
      eventType: "color_changed",
      actorParticipantId: participant.id,
      payload: { participantId: participant.id, color: paletteEntry.hex },
      write: async (tx) => {
        // Authoritative uniqueness check — see joinRoom's write callback for
        // why the row lock from withRoomRevision's revision bump makes this
        // race-free.
        const memberColorsInTx = await tx
          .select({
            participantId: roomMembers.participantId,
            color: participants.color,
          })
          .from(roomMembers)
          .innerJoin(
            participants,
            eq(roomMembers.participantId, participants.id)
          )
          .where(eq(roomMembers.roomId, roomId))
        const takenByOtherInTx = memberColorsInTx.some(
          (row) =>
            row.color === paletteEntry.hex &&
            row.participantId !== participant.id
        )
        if (takenByOtherInTx) {
          throw new ColorTakenError()
        }

        await tx
          .update(participants)
          .set({ color: paletteEntry.hex })
          .where(eq(participants.id, participant.id))
      },
    })
  } catch (err) {
    if (err instanceof ColorTakenError) {
      return { ok: false, error: err.message }
    }
    throw err
  }

  // Nudge the room to recolour this member's avatar/marker (ADR 0012). Fired
  // after commit and best-effort — a realtime hiccup must not fail the change.
  try {
    await broadcastRoomEvent(roomId, {
      type: "member:update",
      kind: "color",
      participantId: participant.id,
      name: participant.displayName,
      color: paletteEntry.hex,
    })
  } catch (err) {
    console.warn("changeColor: broadcast member:update failed", err)
  }

  return { ok: true, color: paletteEntry.hex }
}
