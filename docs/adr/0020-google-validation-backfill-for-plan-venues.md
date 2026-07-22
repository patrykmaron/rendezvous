# 0020. Validate and backfill plan venues against Google Places (New)

**Status:** Accepted
**Date:** 2026-07-22

## Context

Plan venues come from a ClickHouse Foursquare serving table (`ch-get-venues`) that is a **November 2024 snapshot**. It is now July 2026, so some venues it returns are closed or gone. Live evidence (room `cb458a12`): a plan surfaced venues that no longer resolve on Google, so every preview card showed "Preview unavailable" and the group rightly distrusted the recommendation.

ADR 0018 added on-demand Google Places **previews** (a click-time enrichment) but did nothing about venue **liveness** at plan-build time — a dead venue still made it into the plan and onto the map. ADR 0018's Phase-E work fixed venue *relevance* (the social/category ClickHouse filter); this ADR fixes venue *liveness*.

`GOOGLE_PLACES_KEY` is already present server-side (verified today: a Text Search returned Hawksmoor Seven Dials, OPERATIONAL, 4.6). It must stay server/tasks-only and never become a hard dependency.

Separately, the ADR-0018 preview route shipped with an `X-Goog-FieldMask` containing spaces after commas; Google's parser 400s on a padded mask, which silently degraded **every** preview to `unavailable`. Fixed here as part of touching the same masks.

## Decision

We will validate Foursquare-sourced plan venues against Google Places (New) **inside `ch-get-venues`**, and backfill thin cells from Google Text Search — entirely skipped when `GOOGLE_PLACES_KEY` is unset. This extends ADR 0018.

- **New helper** `packages/tasks/src/lib/google-places.ts` (no SDK): `searchText({query,lat,lng,radius,fieldMask,pageSize})` → parsed places or `null`, plus `haversineMeters`. Every call is single-attempt with a 10s `AbortSignal.timeout`; any failure (no key, network, timeout, non-2xx, non-JSON) returns `null`, distinct from `[]` (a definitive "nothing there"). Field masks are **comma-separated with no spaces** — Google 400s on padded masks.
- **Validate** each venue (all finalist cells, ≤15) with a `pageSize:1` Text Search biased 250m to its coords:
  - a result **within 500m AND `businessStatus:"OPERATIONAL"`** → keep, set `verified:true` + `googlePlaceId`/`rating`/`userRatingCount`;
  - a result that is closed, >500m away, or absent → **drop** the venue;
  - a **failed/timed-out call** → keep the venue **unverified** (availability ≠ closure — an API blip must never empty a plan).
- **Backfill** any cell left with <3 survivors: **one** Text Search around the cell centroid (mean of that cell's original CH venue coords), `pageSize:5`, query = the category keywords (or `"restaurant bar cafe"`). Results map to `source:"google"`, `verified:true` venues, deduped against survivors by name (case-insensitive) + <100m. Per cell, order matched+verified → verified → unverified, cap 5.
- **Billing cap:** ≤15 validation + ≤3 backfill calls, hard belt-and-suspenders cap of **20** calls per analysis run; parallel fetches; never loop or retry. Worst case per run is 18 calls.
- **Type twins stay field-for-field mirrors,** all new fields optional so old snapshots parse: `Venue` (get-venues.ts), the `planCandidate` zod venue (analysis/types.ts), and `PlanCandidate.venues` (apps/web/lib/types.ts) gain `verified?`, `source?`, `googlePlaceId?`, `rating?`, `userRatingCount?`; `fsqPlaceId`/`category` become optional (backfilled venues have neither).
- **`googlePlaceId` threaded to the preview flow** (alongside `fsqPlaceId` from ADR 0018): `OverlayPin`/`MapOverlay.pins`/`PlacePreviewTarget` gain it, and the preview route accepts an optional `gp` param (validated `^[A-Za-z0-9_-]{1,128}$`). When present it **GETs `/v1/places/{gp}` directly** with the detail field mask — exact and cheaper than Text Search, no haversine guard — in its own `gp:<gp>|<name>|<lat>|<lng>` cache-key namespace (a forged `gp` lands in its own key, preserving ADR 0018's poisoning fix). Rate limiting and coalescing apply unchanged.
- **Preview card honesty:** `businessStatus` is added to the route's masks and to `PlacePreview`; the card shows a destructive "Permanently closed" / amber "Temporarily closed" badge in place of the open-now dot, and the `not_found` fallback card gains a zero-cost "Search on Google Maps" link so a dead venue still gives the user an action.
- **Model guidance:** one line in `BASE_INSTRUCTIONS` — prefer `verified` venues and optionally mention a standout rating.

Alternatives considered and rejected:

- **Validate lazily at preview time only** (no plan-build validation) — rejected: the dead venue is already in the plan, on the map, and in the chat card; the user distrusts the whole recommendation before ever clicking. Liveness has to be enforced before the venue is shown.
- **Drop on any non-OPERATIONAL/absent status without keeping-on-error** — rejected: a Google outage would then empty plans. Failed calls keep the venue unverified.
- **Refresh the Foursquare snapshot** — out of scope and no fresher licensed dataset is on hand; per-venue live validation is the pragmatic fix.

## Consequences

- **FSQ staleness no longer reaches users:** confirmed-closed or unresolvable venues are dropped before the plan is assembled, and thin cells are refilled with live Google venues.
- **Cost:** ~$0.30–0.40 per analysis run at current Places (New) SKUs (≤18 Text Search calls), bounded by the 20-call cap; zero when the key is unset.
- **Deployment:** local `trigger dev` reads `GOOGLE_PLACES_KEY` from the symlinked `.env`, but **Trigger.dev deployed runs need the key added in the Trigger dashboard** (`npx trigger.dev env` or the UI) — otherwise deployed analyses silently skip validation and fall back to unvalidated Foursquare venues.
- **More optional fields to keep in sync** across the three venue type copies — same field-for-field-mirror convention ADR 0018 already established, not a new pattern.
- Over-dropping (a live venue Google returns without an OPERATIONAL status) is possible but compensated by backfill; the safer failure direction for "never recommend a dead place".
- The preview FieldMask spaces bug is fixed, so ADR 0018's previews actually resolve now.
