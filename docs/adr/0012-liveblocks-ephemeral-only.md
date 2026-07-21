# 0012. Liveblocks for ephemeral multiplayer state only

**Status:** Accepted (implemented; see ADR 0014)
**Date:** 2026-07-17

## Context

Rendezvous is multiplayer: a group plans together on a shared canvas. That needs presence (who's here, cursors, what someone is dragging or hovering) — and it's tempting to let the realtime layer also hold application state. But durable state already has an authoritative home with revisions and an event log ([0007](0007-event-log-room-revisions.md)); a second writable source of truth would fork it.

## Decision

Liveblocks handles **only ephemeral, presence-shaped state**: colored cursors, avatar stacks, hover/selection, temporary drag positions, an "AI agent is working" presence while Trigger.dev runs. It never stores constraints, origins, votes, messages, or plans.

The rule: **Liveblocks shows what someone is *doing*; Postgres records what they *did*.** Durable changes go through the API → Postgres transaction → room event; realtime clients then receive a small "state changed" nudge (e.g. `PLAN_UPDATED`) and refetch the authoritative state.

## Consequences

- One source of truth; replaying `room_events` reconstructs any room without consulting the realtime layer.
- Losing the Liveblocks connection degrades presence, never data.
- Slightly more plumbing than mutating shared realtime storage directly — accepted to keep the event log authoritative.
- This ADR fixed the boundary before the first line of realtime code was written; the mechanism it sketched shipped, refined, in [0014](0014-realtime-broadcasts-and-session-identity.md).
