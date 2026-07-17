# 0009. One root `.env`, symlinked into consuming workspaces

**Status:** Accepted
**Date:** 2026-07-17

## Context

Three tools load environment variables from three different directories, each with its own rules: Next.js reads `.env*` only from `apps/web/`, the Trigger.dev CLI reads `.env` from its cwd (`packages/tasks/`), and drizzle-kit/`clickhouse-migrations` run in `packages/db/` and load nothing automatically. Duplicating six credentials across three files guarantees drift.

## Decision

A single gitignored `.env` at the repo root is the only place values exist. Consumers reach it three ways:

- `apps/web/.env` and `packages/tasks/.env` are **symlinks** to `../../.env` (both tools read through symlinks).
- `packages/db` scripts point at it explicitly: `dotenv` with `path: "../../.env"` in `drizzle.config.ts`, `dotenv-cli -e ../../.env` for `ch:migrate`, `tsx --env-file=../../.env` for the smoke test.

A committed `.env.example` documents the variable names (`DATABASE_URL`, `DATABASE_URL_DIRECT`, `CLICKHOUSE_URL/_USER/_PASSWORD/_DATABASE`), with `!.env.example` re-included past the `.env*` gitignore rule. All names are declared in `turbo.json` `globalEnv` so caching is env-aware and the `turbo/no-undeclared-env-vars` lint rule stays quiet.

## Consequences

- One file to edit; no value is ever duplicated.
- The symlinks are untracked, so `.env` setup is a documented one-time step (CLAUDE.md, README) — a fresh clone that skips it gets clear "missing env" errors from the lazy clients.
- Trigger.dev **deployed** runs don't read `.env` at all; the same variables must be set in the Trigger dashboard before deploying tasks.
