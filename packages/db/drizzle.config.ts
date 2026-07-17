import { config } from "dotenv"
import { defineConfig } from "drizzle-kit"

config({ path: "../../.env" })

// Migrations must bypass PgBouncer (transaction pooling breaks DDL), so
// prefer the direct-connection URL.
const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL

if (!url) {
  throw new Error("DATABASE_URL_DIRECT or DATABASE_URL must be set")
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/postgres/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
})
