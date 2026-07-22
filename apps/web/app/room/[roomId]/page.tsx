import { notFound } from "next/navigation"

import { eq, getDb } from "@workspace/db/postgres"
import { rooms } from "@workspace/db/schema"

import { UUID_RE } from "@/lib/validate"

import { RoomShell } from "./room-shell"

export default async function RoomPage({
  params,
}: {
  params: Promise<{ roomId: string }>
}) {
  const { roomId } = await params
  // Validate before hitting Postgres: a non-UUID would make the uuid-typed
  // comparison error out (500) instead of cleanly 404ing.
  if (!UUID_RE.test(roomId)) {
    notFound()
  }

  const db = getDb()
  const [room] = await db
    .select({ id: rooms.id, name: rooms.name, settings: rooms.settings })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1)
  if (!room) {
    notFound()
  }

  return (
    <RoomShell
      roomId={room.id}
      roomName={room.name}
      initialEventAt={room.settings?.eventAt ?? null}
    />
  )
}
