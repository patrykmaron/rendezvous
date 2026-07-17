import { logger, task } from "@trigger.dev/sdk/v3"
import { chQuery } from "@workspace/db/clickhouse/query"
import { getDb, sql } from "@workspace/db/postgres"

export const dbSmokeTask = task({
  id: "db-smoke",
  maxDuration: 60,
  run: async () => {
    const db = getDb()
    const pg = await db.execute(sql`select 1 as ok`)
    const [places] = await chQuery<{ n: string }>(
      "SELECT count() AS n FROM places"
    )

    logger.log("db-smoke", { postgres: pg[0], places: places?.n })

    return {
      postgres: pg[0]?.ok === 1 ? "ok" : "error",
      clickhousePlaces: Number(places?.n ?? 0),
    }
  },
})
