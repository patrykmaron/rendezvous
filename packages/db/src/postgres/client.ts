import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js"
import postgres from "postgres"

import { requireEnv } from "../env"
import * as schema from "./schema"

export type Db = PostgresJsDatabase<typeof schema>

// DATABASE_URL points at PgBouncer (transaction pooling), so prepared
// statements must be disabled. The raw client is cached on globalThis in
// dev so Next.js HMR doesn't leak connections against the managed instance.
const globalForDb = globalThis as unknown as {
  __rendezvousSql?: ReturnType<typeof postgres>
}

let db: Db | undefined

export function getDb(): Db {
  if (!db) {
    const sql =
      globalForDb.__rendezvousSql ??
      postgres(requireEnv("DATABASE_URL"), {
        ssl: "require",
        prepare: false,
        max: 5,
      })
    if (process.env.NODE_ENV !== "production") {
      globalForDb.__rendezvousSql = sql
    }
    db = drizzle(sql, { schema })
  }
  return db
}

export * as schema from "./schema"
export { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
