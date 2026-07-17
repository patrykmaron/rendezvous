# 0007. Append-only event log with a per-room revision counter

**Status:** Accepted
**Date:** 2026-07-17

## Context

Multiple participants mutate a room concurrently (origins, constraints, votes) while Trigger.dev runs multi-step analyses against a snapshot of that state. Two problems follow: analyses must be attributable to an exact room state (is this plan stale?), and the planned ClickPipes CDC analytics need clean append-only data — mutable-row CDC exposes intermediate row versions until ClickHouse deduplicates.

## Decision

Every durable change goes through one pattern, in a single transaction:

```sql
UPDATE rooms SET current_revision = current_revision + 1, updated_at = now()
  WHERE id = $room RETURNING current_revision;   -- row-locks the room
INSERT INTO room_events (room_id, revision, event_type, actor_participant_id, payload)
  VALUES (...);
```

The `UPDATE … RETURNING` serializes concurrent writers on the room row; `UNIQUE (room_id, revision)` is the backstop (retry on violation). Read-then-write revision handling is forbidden. `room_events` is append-only — no updates, no deletes.

Analyses snapshot the revision they ran against (`plan_snapshots.room_revision`, carried into every ClickHouse row), so staleness is a plain integer comparison against `rooms.current_revision`.

## Consequences

- Any plan, score, or route observation is traceable to the exact room state that produced it; stale analyses are detectable and re-runnable.
- The event stream is the ideal CDC source for ClickHouse plan-evolution analytics (constraint-impact waterfalls, consensus progression) — no dedup concerns.
- Writers pay a room-row lock per change — correct behavior for a small collaborative group, not a throughput concern.
- The transaction pattern is documented in `schema.ts` and must be used by every write path; a helper in the API layer should make it the path of least resistance.
