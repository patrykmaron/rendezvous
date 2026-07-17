// End-to-end smoke test against the live databases.
// Run with: pnpm --filter @workspace/db smoke
import { eq, sql } from "drizzle-orm"

import { chCommand, chInsert, chQuery, toChDateTime } from "./clickhouse/query"
import { getDb } from "./postgres/client"
import { roomEvents, rooms } from "./postgres/schema"

async function main() {
  const db = getDb()

  const ping = await db.execute(sql`select 1 as ok`)
  console.log("postgres SELECT 1:", ping)

  // Roundtrip: create a room, bump its revision with an event (the canonical
  // transaction pattern), read it back, delete it (events cascade).
  const [room] = await db
    .insert(rooms)
    .values({ name: "smoke-test room" })
    .returning()
  if (!room) throw new Error("room insert returned no row")

  const revision = await db.transaction(async (tx) => {
    const [bumped] = await tx
      .update(rooms)
      .set({
        currentRevision: sql`${rooms.currentRevision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(rooms.id, room.id))
      .returning({ currentRevision: rooms.currentRevision })
    if (!bumped) throw new Error("revision bump returned no row")
    await tx.insert(roomEvents).values({
      roomId: room.id,
      revision: bumped.currentRevision,
      eventType: "room_created",
      payload: { name: room.name },
    })
    return bumped.currentRevision
  })

  const found = await db.query.rooms.findFirst({
    where: eq(rooms.id, room.id),
  })
  console.log("postgres roundtrip:", {
    id: found?.id,
    name: found?.name,
    revision,
  })

  await db.delete(rooms).where(eq(rooms.id, room.id))
  const gone = await db.query.rooms.findFirst({ where: eq(rooms.id, room.id) })
  if (gone) throw new Error("room was not deleted")
  console.log("postgres cleanup: room + cascaded event deleted")

  const [places] = await chQuery<{ n: string }>(
    "SELECT count() AS n FROM places"
  )
  console.log("clickhouse places count:", places?.n)
  if (places?.n !== "4438857") {
    throw new Error(`unexpected places count: ${places?.n}`)
  }

  const migrations = await chQuery<{ version: number; migration_name: string }>(
    "SELECT version, migration_name FROM _migrations ORDER BY version"
  )
  console.log(
    "clickhouse migrations:",
    migrations.map((m) => `${m.version}:${m.migration_name}`).join(", ")
  )

  // route_observations roundtrip with a throwaway analysis_id, then a
  // lightweight DELETE so repeated smoke runs don't accumulate rows.
  const analysisId = crypto.randomUUID()
  await chInsert("route_observations", [
    {
      analysis_id: analysisId,
      room_id: crypto.randomUUID(),
      room_revision: 1,
      participant_id: crypto.randomUUID(),
      candidate_h3: "613226207503564799",
      provider: "smoke",
      transport_mode: "tube",
      departure_time: toChDateTime(new Date()),
      duration_seconds: 1800,
      walking_seconds: 300,
      interchange_count: 1,
      accessibility_ok: 1,
      route_status: "ok",
    },
  ])
  const observed = await chQuery<{ candidate_h3: string; provider: string }>(
    "SELECT candidate_h3, provider FROM route_observations WHERE analysis_id = {analysisId: UUID}",
    { analysisId }
  )
  if (observed[0]?.candidate_h3 !== "613226207503564799") {
    throw new Error("route_observations roundtrip failed")
  }
  console.log("clickhouse route_observations roundtrip:", observed[0])
  await chCommand(
    "DELETE FROM route_observations WHERE analysis_id = {analysisId: UUID}",
    { analysisId }
  )
  console.log("clickhouse cleanup: smoke observation deleted")
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("smoke test failed:", error)
    process.exit(1)
  })
