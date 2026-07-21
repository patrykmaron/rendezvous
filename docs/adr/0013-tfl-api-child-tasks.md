# 0013. TfL API access via per-endpoint Trigger.dev child tasks

**Status:** Accepted
**Date:** 2026-07-21

## Context

The analysis pipeline ([0011](0011-trigger-dev-orchestration.md)) needs London journey planning and Santander bike availability from the TfL Unified API. Parent "agent" tasks will fan out dozens of `triggerAndWait` calls, so per-call outputs land in parent payloads and agent context — raw TfL journey responses run to hundreds of KB. TfL quirks verified against the live API: an **invalid `app_key` returns HTTP 429** (plain text body), the same status as rate limiting (500 req/min per key, no `Retry-After` header); ambiguous free-text locations return **HTTP 300** with a `DisambiguationResult`; error bodies are variously JSON (`ApiError`), plain text, or Cloudflare HTML; and the published OpenAPI mode list doesn't match the live `/Journey/Meta/Modes` ids. The API portal issues a primary and a secondary key; both are set in the Trigger dashboard and the root `.env` ([0009](0009-single-root-env.md)).

## Decision

We will wrap each TfL endpoint in its own Trigger.dev task (`tfl-journey-plan`, `tfl-journey-modes`, `tfl-bikepoints-list`, `tfl-bikepoint-get`, `tfl-bikepoints-search`), sharing one client (`packages/tasks/src/tfl/`), with these conventions:

- **`schemaTask` + zod payloads** for every task going forward — invalid arguments fail before an HTTP call, and payloads are typed for parent tasks. zod becomes a direct dependency of `@workspace/tasks`.
- **Compact typed outputs, never raw passthrough.** Mappers extract only what parents need (journey legs/durations/fares; bike dock occupancy parsed from `additionalProperties`, including the broken-docks gap). zod extraction schemas with all-optional fields strip everything else.
- **Semantic outcomes are return values, not errors.** HTTP 300 → `kind: "disambiguation"` (options to re-trigger with), journey 404 → `kind: "no_journeys"`, unknown bike point → `kind: "not_found"`. Deterministic outcomes must not burn task retries; throwing is reserved for transient/unexpected failures, where task-level retries (outer layer) still apply.
- **`retry.fetch` with backoff for 429/5xx/timeouts/connection errors** inside the run, and a **one-shot secondary-key fallback when the final response is still 429** — covering both rate limiting and a revoked primary key with one rule. The key travels as a header, never a query param, because `retry.fetch` records full request URLs in dashboard-visible span attributes.

Alternatives considered: one generic "call TfL" task (loses per-endpoint typing and dashboard clarity); raw response passthrough (output bloat, every consumer re-parses TfL's entity bags); throwing on 300/404 (`triggerAndWait` serializes errors lossily and retries pointlessly).

## Consequences

- Parent tasks compile against the simplified output types — they are a contract; extending them is additive, reshaping them is a breaking change.
- Mode ids must come from `tfl-journey-modes` at runtime, not hardcoded lists.
- A 429 is ambiguous (bad key vs rate limit) — the client logs the body snippet to disambiguate in the dashboard.
- At 500 req/min/key, the future parent fan-out ([0011](0011-trigger-dev-orchestration.md)) must attach these tasks to a shared Trigger queue with a concurrency cap before scaling up.
- Local `trigger dev` needs `TFL_PRIMARY_KEY`/`TFL_SECONDARY_KEY` in the root `.env`; deployed runs read them from the Trigger dashboard.
