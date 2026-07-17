# 0011. Trigger.dev orchestrates all analysis workflows

**Status:** Accepted
**Date:** 2026-07-17

## Context

Producing a plan is a multi-step, minutes-long pipeline: wait for replicated state, generate candidate areas, fan out dozens of parallel journey-API calls (rate-limited, retryable), insert observations, rank in ClickHouse, write a snapshot back to Postgres. Next.js request handlers are the wrong home for this — no durability, no retries, no fan-out, request timeouts. The hackathon also requires meaningful Trigger.dev use.

## Decision

All background computation runs as **Trigger.dev v4 tasks** in `packages/tasks` (`@workspace/tasks`), consuming `@workspace/db` directly. The planned analysis workflow per room revision:

```text
roomEventCreated
  → waitForClickHouseRevision (once CDC lands)
  → generateCandidateH3Cells          (ClickHouse)
  → calculateParticipantRoutes        (parallel fan-out, TfL API)
  → insertRouteObservations           (ClickHouse)
  → queryCandidateScores              (ClickHouse ranking)
  → retrieveMatchingVenues            (top areas only)
  → writePlanSnapshotToPostgres       (denormalized result + revision)
```

Tasks stream progress states to the UI ("Comparing 30 candidate areas… calculating 120 journeys…") so the canvas shows the agent working. Next.js API routes stay thin: validate, write the room event, trigger the task.

## Consequences

- Retries, concurrency limits, and observability of the pipeline come from the platform, not hand-rolled queues.
- The web app never blocks on analysis; results arrive via `plan_snapshots` (and later a realtime nudge to refetch).
- Local dev needs a second process (`npx trigger.dev@latest dev` in `packages/tasks`); the `db-smoke` task verifies DB connectivity end-to-end.
- Deployed tasks read env from the Trigger dashboard, not `.env` ([0009](0009-single-root-env.md)).
