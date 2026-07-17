# 0008. Use the H3 grid and a candidate funnel for geospatial analysis

**Status:** Accepted
**Date:** 2026-07-17

## Context

Finding the fairest meeting area means comparing journey friction for every participant across many candidate locations, against 4.4M venues. Routing every participant to every venue via a journey API is combinatorially impossible (and rate-limited). We need a discrete spatial unit that makes "area" a first-class, aggregatable thing.

## Decision

We will use **Uber's H3 hexagonal grid** as the spatial unit everywhere (the Foursquare source data is already H3-bucketed):

- ClickHouse `places` is ordered by materialized `h3_7, h3_8` cells (`geoToH3`); `area_category_counts` aggregates venue categories per cell — "which areas have the venue mix this group wants" is an index-ordered read.
- Candidate meeting areas *are* H3 cells; routing targets are cell centroids.

Journey calculation follows a **funnel**: generate candidate cells in ClickHouse from the group's travel envelope → route each participant to ~20–30 centroids (TfL Journey Planner API, fanned out by Trigger.dev) → rank all candidates in ClickHouse (`candidate_scores`) → fetch venues only for the top areas → exact door-to-door journeys only for finalists.

**Representation rule:** H3 indexes are `UInt64` in ClickHouse but must cross every JS boundary as **decimal strings** — JS numbers corrupt above 2^53 (observed in practice: `…799` deserialized as `…800`). The ClickHouse client pins `output_format_json_quote_64bit_integers: 1`; Postgres stores cells as `text`.

## Consequences

- API calls scale with participants × candidate areas (~120 journeys), not participants × venues (millions).
- Area-level scoring, venue coverage, and fairness ranking are single ClickHouse queries over the cell-ordered tables.
- Hex cells are honest about "areas" (uniform adjacency, no corner distortion) but candidate centroids are approximations — accepted, since finalists get exact routing.
- The string-encoding rule for UInt64 is load-bearing and enforced in `@workspace/db`; bypassing `chQuery`/`chInsert` risks silent coordinate corruption.
