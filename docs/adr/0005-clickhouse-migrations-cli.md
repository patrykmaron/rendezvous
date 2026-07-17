# 0005. Manage ClickHouse schema with the `clickhouse-migrations` CLI and an idempotent baseline

**Status:** Accepted
**Date:** 2026-07-17

## Context

The ClickHouse schema (raw Foursquare table, `places` serving table, materialized views, aggregates) was originally created by hand in the console while loading the 4.4M-row UK extract. That state was invisible to the repo: not reviewable, not reproducible, not presentable. Drizzle does not support ClickHouse, so Postgres tooling can't cover this.

## Decision

We will manage ClickHouse DDL as numbered SQL files (`packages/db/clickhouse/migrations/N_name.sql`) applied by the third-party **`clickhouse-migrations`** CLI (chosen over a custom runner — maintained, checksummed, zero code to own), wired to our canonical `CLICKHOUSE_*` env vars via the `ch:migrate` script.

Two rules make this safe against a live service:

1. **Migration 1 is an idempotent baseline**: the hand-built objects transcribed from live `SHOW CREATE TABLE` output, every statement `IF NOT EXISTS`. Applying it to the live service is a no-op that records version 1; applying it to a fresh service reproduces the schema exactly.
2. **Engines are written as plain `MergeTree`/`SummingMergeTree`**, never `SharedMergeTree(...)` with args — ClickHouse Cloud maps plain engines to their Shared equivalents automatically, keeping the SQL portable.

New tables (`route_observations`, `candidate_scores`) arrive as ordinary numbered migrations.

## Consequences

- The full analytical schema is reviewable in the repo and reproducible from zero (data load is a separately documented one-time step).
- Applied files are md5-checksummed in a `_migrations` table: **never edit an applied migration** — fixes are new numbered files. Same rule as Drizzle's journal, so one habit covers both databases.
- All statements must stay idempotent so a fresh environment and the live service converge on identical state.
- We depend on a small third-party CLI; if it dies, the escape hatch is trivial (numbered SQL files + a tracking table are easy to re-implement).
