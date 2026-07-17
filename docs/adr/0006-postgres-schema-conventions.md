# 0006. Schema conventions: uuid PKs, text + TS unions instead of pg enums

**Status:** Accepted
**Date:** 2026-07-17

## Context

The Postgres schema (10 tables) needs conventions that survive hackathon-speed iteration: identifiers appear in shareable URLs and must join across two databases; enum-ish fields (statuses, roles, event types) will grow new values weekly.

## Decision

- **Primary keys are `uuid` with `gen_random_uuid()`** — URL-shareable (room links, invites), generatable app-side, and they join directly against the `UUID` columns in ClickHouse (`room_id`, `analysis_id`, `participant_id` cross the store boundary unchanged). Exception: `room_events` uses a `bigint` identity PK — an internal append-only log where a cheap monotonic id aids debugging; its real key is `(room_id, revision)`.
- **Enum-ish fields are `text` columns typed by `as const` TS unions** (`RoomStatus`, `RoomEventType`, …), not Postgres enums. Adding a value is a code change, not an `ALTER TYPE` migration; type safety lives in TypeScript where both web and tasks consume it.
- **Timestamps are `timestamptz` with `defaultNow()`**; flexible payloads are `jsonb` with `.$type<T>()` where the shape is known.
- **Delete behavior:** room-scoped tables cascade from `rooms`; actor references (`created_by`, `actor_participant_id`) are `set null` so history survives participant deletion.
- **H3 cells are stored as `text`** in Postgres and converted to UInt64 decimal strings at the ClickHouse boundary ([0008](0008-h3-geospatial-grid.md)).

## Consequences

- No enum migrations, ever; invalid values are possible at the SQL level — accepted, since all writes go through typed application code.
- uuid PKs are larger than bigints — irrelevant at this scale, and the cross-database join simplicity pays for it.
- Inferred `$inferSelect`/`$inferInsert` types from `@workspace/db/schema` are the single source of type truth for both runtimes.
