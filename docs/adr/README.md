# Architecture Decision Records

This folder records the significant architectural decisions made in Rendezvous, in the order they were made. Each ADR captures the context at the time, the decision, and its consequences — including the trade-offs we accepted.

An ADR is immutable once accepted: if a decision is reversed or refined, a new ADR supersedes the old one (and the old one's status is updated to point at it).

## Index

| #                                           | Decision                                                                              | Status   |
| ------------------------------------------- | ------------------------------------------------------------------------------------- | -------- |
| [0001](0001-turborepo-pnpm-monorepo.md)     | Turborepo + pnpm monorepo from the shadcn/ui template                                 | Accepted |
| [0002](0002-two-database-architecture.md)   | Two databases: Postgres for OLTP, ClickHouse for OLAP                                 | Accepted |
| [0003](0003-shared-db-package-raw-ts.md)    | One shared `@workspace/db` package shipping raw TypeScript                            | Accepted |
| [0004](0004-drizzle-orm-pgbouncer.md)       | Drizzle ORM, with PgBouncer for runtime and direct connections for migrations         | Accepted |
| [0005](0005-clickhouse-migrations-cli.md)   | ClickHouse migrations via the `clickhouse-migrations` CLI with an idempotent baseline | Accepted |
| [0006](0006-postgres-schema-conventions.md) | Schema conventions: uuid PKs, text + TS unions instead of pg enums                    | Accepted |
| [0007](0007-event-log-room-revisions.md)    | Append-only event log with per-room revision counter                                  | Accepted |
| [0008](0008-h3-geospatial-grid.md)          | H3 hexagonal grid and a candidate funnel for geospatial analysis                      | Accepted |
| [0009](0009-single-root-env.md)             | Single root `.env` symlinked into consuming workspaces                                | Accepted |
| [0010](0010-bundler-module-resolution.md)   | Bundler module resolution and TypeScript 5 across shared packages                     | Accepted |
| [0011](0011-trigger-dev-orchestration.md)   | Trigger.dev orchestrates all analysis workflows                                       | Accepted |
| [0012](0012-liveblocks-ephemeral-only.md)   | Liveblocks for ephemeral multiplayer state only                                       | Accepted |
| [0013](0013-tfl-api-child-tasks.md)         | TfL API access via per-endpoint Trigger.dev child tasks                               | Accepted |

## Adding an ADR

Copy [template.md](template.md) to `NNNN-short-title.md` (next number in sequence), fill it in, and add a row to the index above. Keep it short — a decision a teammate can absorb in two minutes beats a design doc nobody reads.
