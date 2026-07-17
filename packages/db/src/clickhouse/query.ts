import { getClickHouse } from "./client"

/**
 * Run a parameterized query and return typed rows. Always pass values via
 * `params` (`{name: Type}` placeholders in the query) — never interpolate.
 * UInt64 values (e.g. H3 cells) must be passed and read as decimal strings;
 * JS numbers corrupt above 2^53.
 */
export async function chQuery<T>(
  query: string,
  params?: Record<string, unknown>
): Promise<T[]> {
  const resultSet = await getClickHouse().query({
    query,
    query_params: params,
    format: "JSONEachRow",
  })
  return resultSet.json<T>()
}

export async function chInsert<T extends Record<string, unknown>>(
  table: string,
  rows: T[]
): Promise<void> {
  await getClickHouse().insert({ table, values: rows, format: "JSONEachRow" })
}

/** For statements that return no rows (DDL, DELETE, ALTER, ...). */
export async function chCommand(
  query: string,
  params?: Record<string, unknown>
): Promise<void> {
  await getClickHouse().command({ query, query_params: params })
}

/** DateTime columns want "YYYY-MM-DD HH:MM:SS" (UTC), not a raw Date. */
export function toChDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ")
}
