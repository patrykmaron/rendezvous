# 0004. Use Drizzle ORM, PgBouncer for runtime, direct connections for migrations

**Status:** Accepted
**Date:** 2026-07-17

## Context

The Managed Postgres instance exposes two endpoints: PgBouncer (transaction pooling) on port 6432 and a direct connection on port 5432. Connections come from two elastic runtimes — Next.js route handlers and parallel Trigger.dev tasks — which can easily exhaust direct connection slots. Schema needs migrations that are reviewable SQL.

## Decision

We will use **Drizzle ORM** with the postgres.js driver and **drizzle-kit** for generated SQL migrations, split by endpoint:

- **Runtime** (`DATABASE_URL`): PgBouncer on 6432, with `prepare: false` (prepared statements break under transaction pooling), `ssl: "require"`, and a `globalThis`-cached client in dev so Next HMR doesn't leak connections.
- **Migrations** (`DATABASE_URL_DIRECT`): direct 5432 — DDL through a transaction-mode pooler is unreliable.

Drizzle over Prisma: no codegen step, SQL-shaped queries, first-class TypeScript inference, and generated migrations that read as plain SQL (good for judges). Raw SQL without an ORM was rejected — we want inferred types shared across web and tasks.

## Consequences

- Elastic consumers scale against PgBouncer instead of eating direct slots.
- Every schema change is `db:generate` → review SQL → `db:migrate`; applied migrations are frozen by Drizzle's journal.
- The two-URL split must be maintained in every environment ([0009](0009-single-root-env.md)).
- `prepare: false` costs some per-query latency — acceptable at this scale.
