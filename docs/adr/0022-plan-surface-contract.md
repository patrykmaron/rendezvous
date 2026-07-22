# 0022. The plan surface contract: retention, geometry placement, votes, and settings

**Status:** Accepted
**Date:** 2026-07-22

## Context

A plan is now read by several surfaces at once — the chat `PlanCard`, the map-pane venue carousel, and the map overlay — and the plan itself gained journeys (per-participant TfL routes with leg geometry), votes, and a "decided" venue. Three problems surfaced together:

- **Blanking on re-run.** A `plan_snapshots` row is inserted in status `running` the instant an analysis starts (including an auto-replan, ADR 0021). The `/plan` route returned the newest snapshot regardless of status, and `PlanCard` renders nothing for `running`/`pending`/`failed`, so a good plan vanished the moment the agent started rethinking.
- **Geometry is large.** Full journey geometry is ~150KB at N=5 origins — fine in Postgres jsonb and over HTTP, but run metadata is capped at 256KB and is streamed to every subscribed tab.
- **Votes and decisions attach to a snapshot**, and a re-run produces a new snapshot; the lifecycle of a vote across snapshots had to be pinned down. Event time and the decision both live in the flexible `rooms.settings` jsonb and are written from multiple call sites.

These are one contract, decided once so the chat, carousel, and map cannot drift.

## Decision

We will define a single `PlanResponse` contract with explicit retention, and fixed rules for geometry, votes, and settings.

- **Retention rule (`/api/rooms/[roomId]/plan`).** Always 200. `plan` = the newest snapshot with `status = 'complete'`; only if **no** snapshot was ever complete does it fall back to the newest-overall (so a first run that is still running or has failed renders exactly as before). `replanning` = the newest-overall snapshot is `running`/`pending`. `updateFailed` = the newest-overall is `failed` **and** a complete plan exists. The consequence: a re-run or a failed re-run **never blanks a good plan** — the client keeps showing the retained complete plan with an "Updating…" / "Couldn't update — showing the previous one" affordance, driven by `replanning` / `updateFailed`. `PlanCard` keeps its `running/pending → null` early return, now reachable only before the first plan ever completes (where the agent-activity row covers the gap).
- **State lifted once.** The displayed-plan state lives in `RoomView` (one `use-plan` hook fetching `PlanResponse`), so the chat card and the map carousel read one source. `ChatPanel` no longer owns plan state.
- **Geometry placement.** Full per-leg geometry lives **only** in `plan_snapshots.result` (jsonb), fetched by `PlanResponse`. The run **metadata** overlay carries a **capped** copy (`MAX_PATH_POINTS = 50` per leg) to stay well under the 256KB metadata ceiling; it does **not** ride vote broadcasts (those carry tallies only). Missing geometry degrades to straight lines.
- **Votes are per-snapshot.** A vote keys on `plan_snapshots.id`; a new complete snapshot supersedes old votes automatically. Vote hearts are **disabled while `replanning`** — a vote cast on a snapshot about to be superseded is stale noise. Vote broadcasts carry tallies (`voterIds`), never the geometry.
- **Settings jsonb merge discipline.** `rooms.settings` holds `{ eventAt?, decided? }`. Every writer merges with jsonb `||` (add/update) or `- 'key'` (remove) — **never a whole-object overwrite** — so the event-time writer and the decision writer cannot clobber each other.
- **London wall-clock convention.** Event times are stored and compared as London-local ISO wall-clock strings; the TfL journey anchor and the "leave by" derivation use the same convention, so there is no timezone math to get wrong between the picker, the plan, and the routes.

Alternatives considered: returning the newest snapshot regardless of status and letting the client hide it (rejected — every surface would re-implement retention and they would drift); keeping full geometry in run metadata (rejected — blows the 256KB cap at scale and wastes bandwidth on every tab); client-side retention with a `retained` ref (rejected in favour of the server rule — one query, no client cache to invalidate); a `204` empty response (rejected — the always-200 shape carries `replanning`/`updateFailed`/votes/decision uniformly).

## Consequences

- The plan stays put while the agent rethinks; the only visible change during a re-run is the badge, and a failed re-run shows the previous plan rather than an error — demo-safe.
- One indexed extra query per `/plan` fetch (newest-complete alongside newest-overall). Fetches are a handful per session (mount + per `plan:updated` + per completed run); the geometry payload rides them, which is acceptable for jsonb/HTTP.
- The 256KB metadata cap is respected structurally: only the capped overlay is ever set as metadata, so more origins/legs cannot silently overflow it.
- Vote and decision correctness now depend on the settings merge discipline and the per-snapshot vote key; both are conventions, not schema constraints, so a future writer that overwrites `settings` wholesale or votes without the snapshot id would regress silently. This ADR is the record of those invariants.
- `PlanResponse` is the single contract the chat, carousel, and map all consume — a change to the plan shape is a change to this one type.
