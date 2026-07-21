# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All commands run from the repo root via Turborepo (pnpm 10, Node >= 20):

```bash
pnpm dev          # start dev servers (turbo dev)
pnpm build        # build all workspaces
pnpm lint         # eslint across workspaces
pnpm typecheck    # tsc --noEmit across workspaces
pnpm format       # prettier --write
```

Scope any task to a single workspace with `--filter`, e.g. `pnpm --filter web dev` or `pnpm --filter @workspace/ui lint`.

There is no test framework configured in this repo.

### Adding shadcn/ui components

Run from the repo root, targeting the web app:

```bash
pnpm dlx shadcn@latest add <component> -c apps/web
```

Components land in `packages/ui/src/components/` (not in the app) and are imported as `@workspace/ui/components/<name>`.

## Next.js version warning

From AGENTS.md: **this is NOT the Next.js you know.** The installed version (16.x) has breaking changes — APIs, conventions, and file structure may differ from training data. Read the relevant guide in `apps/web/node_modules/next/dist/docs/` before writing Next.js code, and heed deprecation notices.

## Architecture

Turborepo + pnpm workspace monorepo based on the shadcn/ui monorepo template:

- `apps/web` — Next.js App Router app (RSC enabled, React 19). App-local code uses `@/components`, `@/hooks`, `@/lib` aliases; shared UI comes from the ui package.
- `packages/ui` — shared `@workspace/ui` package holding all shadcn components, hooks, utils, and the global stylesheet. Consumed via subpath exports: `@workspace/ui/components/*`, `@workspace/ui/hooks/*`, `@workspace/ui/lib/*`, `@workspace/ui/globals.css`.
- `packages/db` — shared `@workspace/db` package: Drizzle ORM (Postgres) + ClickHouse client and migrations for both databases. See "Databases" below.
- `packages/tasks` — `@workspace/tasks`, Trigger.dev v4 tasks (`src/trigger/*`). Run locally with `npx trigger.dev@latest dev` from `packages/tasks`.
- `packages/eslint-config`, `packages/typescript-config` — shared lint/TS configs extended by each workspace.

Key stack details that differ from common defaults:

- **UI primitives are Base UI (`@base-ui/react`), not Radix.** Components follow the shadcn "base-lyra" style with `class-variance-authority` variants; see `packages/ui/src/components/button.tsx` for the canonical pattern (`data-slot` attribute, `cn()` from `@workspace/ui/lib/utils`).
- **Tailwind CSS v4** — no `tailwind.config` file; theme and CSS variables live in `packages/ui/src/styles/globals.css`.
- **Icons are Phosphor** (`@phosphor-icons/react`), per `components.json` (`iconLibrary: "phosphor"`). Import each icon from its subpath (`@phosphor-icons/react/dist/csr/<Name>`), not the package root — the root barrel doesn't resolve under this repo's NodeNext module resolution.
- **Theming** via `next-themes` (`ThemeProvider` in `apps/web/components/theme-provider.tsx`); fonts are Geist (`--font-sans`), Geist Mono (`--font-mono`), and Lora (`--font-heading`) wired as CSS variables in `apps/web/app/layout.tsx`.

## Architecture decisions

Significant architectural decisions are recorded as ADRs in `docs/adr/` (see the index in `docs/adr/README.md`). When you make a decision of that weight — new dependency, data-model change, cross-cutting convention, reversal of a prior decision — add a new numbered ADR from `docs/adr/template.md` and update the index. Never edit an accepted ADR; supersede it with a new one.

## Databases

Two databases, one package (`@workspace/db`, raw-TS exports, no build step):

- **ClickHouse Managed Postgres** (OLTP: rooms, participants, constraints, votes, events) via **Drizzle ORM**. Schema: `packages/db/src/postgres/schema.ts`. Runtime connections go through **PgBouncer (port 6432)** — the client sets `prepare: false`; migrations use the **direct port 5432** URL (`DATABASE_URL_DIRECT`).
- **ClickHouse Cloud** (OLAP: 4.4M-row Foursquare `places` serving table, `route_observations`, `candidate_scores`) via `@clickhouse/client`. Migrations are plain SQL files in `packages/db/clickhouse/migrations/` applied by the `clickhouse-migrations` CLI.

Imports: `@workspace/db/postgres` (lazy `getDb()`, re-exports `sql`/`eq`/...), `@workspace/db/schema`, `@workspace/db/clickhouse`, `@workspace/db/clickhouse/query` (`chQuery`/`chInsert`/`chCommand`/`toChDateTime`), `@workspace/db/revision` (`withRoomRevision` — every durable room write goes through it).

Env setup (one-time): copy `.env.example` to `.env` at the repo root, fill values, then:

```bash
ln -s ../../.env apps/web/.env
ln -s ../../.env packages/tasks/.env
```

Commands (run against the live cloud services — no local databases):

```bash
pnpm --filter @workspace/db db:generate   # generate Postgres migration from schema changes
pnpm --filter @workspace/db db:migrate    # apply Postgres migrations
pnpm --filter @workspace/db ch:migrate    # apply ClickHouse migrations
pnpm --filter @workspace/db smoke         # end-to-end smoke test of both databases
```

Rules:

- **Never edit an applied migration** (Drizzle journal + clickhouse-migrations md5 checksums both enforce this) — always add a new file. ClickHouse migration files are numbered `N_name.sql` with strictly increasing prefixes and must stay idempotent (`IF NOT EXISTS`).
- ClickHouse DDL uses plain `MergeTree`/`SummingMergeTree` engines — never `SharedMergeTree(...)` with args (Cloud maps plain engines automatically).
- UInt64 values (H3 cells) cross the wire as **decimal strings**, never JS numbers (precision loss above 2^53); the client sets `output_format_json_quote_64bit_integers: 1`.
- Every durable Postgres write must bump `rooms.current_revision` via `UPDATE ... RETURNING` and insert a `room_events` row **in the same transaction** (see comment in `schema.ts`).
- Never import `@workspace/db/*` from a client component. Do not add `server-only` to the package — Trigger.dev tasks share these modules.
- Trigger.dev **deployed** runs read env from the Trigger dashboard (`npx trigger.dev env` or dashboard UI), not from `.env`; local `trigger dev` uses the symlinked `.env`. To verify tasks end-to-end locally, run `npx trigger.dev@latest dev` in `packages/tasks` and test `db-smoke` from the dashboard.
