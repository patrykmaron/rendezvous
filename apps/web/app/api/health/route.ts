import { chQuery } from "@workspace/db/clickhouse/query"
import { getDb, sql } from "@workspace/db/postgres"

export const dynamic = "force-dynamic"

export async function GET() {
  const [pg, [places]] = await Promise.all([
    getDb().execute(sql`select 1 as ok`),
    chQuery<{ n: string }>("SELECT count() AS n FROM places"),
  ])

  return Response.json({
    postgres: pg[0]?.ok === 1 ? "ok" : "error",
    clickhouse: { places: Number(places?.n ?? 0) },
  })
}
