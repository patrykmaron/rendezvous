# 0003. Ship one shared `@workspace/db` package as raw TypeScript

**Status:** Accepted
**Date:** 2026-07-17

## Context

Both the Next.js app (API routes) and the Trigger.dev tasks need the same database access: the Drizzle schema and client for Postgres, and the ClickHouse client and query helpers. Duplicating this per consumer guarantees drift; a compiled package adds a build step to every edit.

## Decision

We will keep all database code in a single `packages/db` (`@workspace/db`) that ships raw TypeScript via subpath exports — no build step, mirroring how `@workspace/ui` works:

- `./postgres` — lazy Drizzle client (also re-exports `sql`, `eq`, … so consumers don't need a direct `drizzle-orm` dependency under pnpm's strict layout)
- `./schema` — Drizzle tables + inferred types
- `./clickhouse` and `./clickhouse/query` — ClickHouse client and typed helpers

There is deliberately **no barrel export**: subpaths keep the Postgres driver out of ClickHouse-only consumers and vice versa. Next.js compiles the package via `transpilePackages`; Trigger.dev's esbuild bundles workspace TS natively. Clients are lazily initialized so importing the package without env vars (e.g. during `next build` page-data collection) never throws, and the package must **not** use `server-only` — Trigger.dev shares the same modules outside Next's runtime.

Alternatives: two packages (postgres/clickhouse) — more plumbing for zero isolation benefit at this scale; a compiled package like `packages/tasks` originally attempted — slower iteration and its `tsc` build was broken anyway.

## Consequences

- One place to change schema or query helpers; both runtimes pick it up instantly.
- `apps/web` must list the package in `transpilePackages` and keep `postgres`/`@clickhouse/client` in `serverExternalPackages`.
- Never import `@workspace/db/*` from a client component — enforced by review, not tooling.
- Module resolution constraints for raw-TS sharing are recorded in [0010](0010-bundler-module-resolution.md).
