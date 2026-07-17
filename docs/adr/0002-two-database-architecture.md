# 0002. Split storage: Postgres for OLTP, ClickHouse for OLAP

**Status:** Accepted
**Date:** 2026-07-17

## Context

Rendezvous has two very different data workloads:

1. **Transactional room state** — rooms, participants, constraints, votes, messages, approved plans. Small rows, strong consistency, foreign keys, frequent small writes.
2. **Analytical/geospatial computation** — searching 4.4M UK Foursquare places, generating candidate meeting areas on the H3 grid, storing route observations, and ranking candidates by fairness. Large scans, aggregations, append-heavy.

The hackathon requires meaningful use of ClickHouse (and Trigger.dev); ClickHouse Cloud also provides a Managed Postgres service, keeping both databases with one vendor.

## Decision

We will run two databases with a hard responsibility boundary:

- **ClickHouse Managed Postgres** is the authoritative source of truth for all persistent application state.
- **ClickHouse Cloud** owns everything analytical: the Foursquare `places` serving table, H3 aggregates, `route_observations`, and `candidate_scores`. It never stores authoritative app state.

Analysis results flow back to Postgres as denormalized `plan_snapshots` so the app never needs ClickHouse to render a decided plan. A ClickPipes CDC pipeline (Postgres `room_events` → ClickHouse) is planned for plan-evolution analytics.

The alternative — one database for everything — fails in both directions: Postgres cannot scan/aggregate 4.4M geospatial rows interactively, and ClickHouse has no place being a transactional store with FKs and upserts.

## Consequences

- Each store does what it is best at; the fairness ranking is a ClickHouse query, not application code.
- Cross-store joins happen via shared UUID keys (`room_id`, `analysis_id`, `participant_id`) — see [0006](0006-postgres-schema-conventions.md).
- Staleness between stores is explicit and detectable via room revisions ([0007](0007-event-log-room-revisions.md)).
- Two connection configs, two migration systems ([0004](0004-drizzle-orm-pgbouncer.md), [0005](0005-clickhouse-migrations-cli.md)) — accepted cost.
