"use server"

import { redirect } from "next/navigation"

import { eq, getDb } from "@workspace/db/postgres"
import { withRoomRevision } from "@workspace/db/revision"
import { participants, roomMembers, rooms } from "@workspace/db/schema"

import { requireMember } from "@/lib/auth"
import { PARTICIPANT_COLORS } from "@/lib/colors"

// Server actions are public HTTP endpoints (callable directly, not just from
// the rendered form) — every input is validated here, never trusted from the
// client.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

  const { result: participant } = await withRoomRevision({
    roomId,
    eventType: "member_joined",
    actorParticipantId: participantId,
    payload: { participantId, name, color: paletteEntry.hex },
    write: async (tx) => {
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
      await tx.insert(roomMembers).values({ roomId, participantId })
      return inserted
    },
  })
  if (!participant) {
    return { ok: false, error: "Failed to join room." }
  }

  // TODO(task-4): broadcast member:update

  return {
    ok: true,
    participantId: participant.id,
    sessionToken: participant.sessionToken,
    name: participant.displayName,
    color: participant.color,
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

  await withRoomRevision({
    roomId,
    eventType: "color_changed",
    actorParticipantId: participant.id,
    payload: { participantId: participant.id, color: paletteEntry.hex },
    write: async (tx) => {
      await tx
        .update(participants)
        .set({ color: paletteEntry.hex })
        .where(eq(participants.id, participant.id))
    },
  })

  // TODO(task-4): broadcast member:update

  return { ok: true, color: paletteEntry.hex }
}
