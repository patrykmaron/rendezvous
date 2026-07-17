import { createClient, type ClickHouseClient } from "@clickhouse/client"

import { requireEnv } from "../env"

let client: ClickHouseClient | undefined

export function getClickHouse(): ClickHouseClient {
  if (!client) {
    client = createClient({
      url: requireEnv("CLICKHOUSE_URL"),
      username: process.env.CLICKHOUSE_USER ?? "default",
      password: requireEnv("CLICKHOUSE_PASSWORD"),
      database: process.env.CLICKHOUSE_DATABASE ?? "rendezvous",
      clickhouse_settings: {
        // UInt64/Int64 (e.g. H3 cells) must arrive as strings — JS numbers
        // silently lose precision above 2^53.
        output_format_json_quote_64bit_integers: 1,
      },
    })
  }
  return client
}
