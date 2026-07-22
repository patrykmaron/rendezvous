# 0018. Server-proxied Google Places (New) venue previews

**Status:** Accepted
**Date:** 2026-07-22

## Context

The room agent proposes venues from a ClickHouse Foursquare serving table (name/category/lat/lng/address only — no photos, ratings, price, or opening hours; see `packages/tasks/src/trigger/analysis/get-venues.ts`). Venue pins on the map and venue names in the chat plan card are currently inert text/dots. A polish pass wants a clickable preview — photo, rating, price, open-now — without switching venue data sources or teaching the room agent to fetch it.

The map camera is frequently animating on its own (0017's attract-mode orbit, `fitBounds`, `flyTo`), so any preview UI has to reposition every frame rather than being placed once; a Mapbox `Popup` already tracks its anchor's screen position per render, which a custom-positioned div would have to reimplement. 0017 explicitly flagged a future preview popup as a second surface that must not fight the orbit/fitBounds/flyTo effects for the camera — this ADR's popup never calls a camera method, so that risk doesn't materialize.

Google Places API (New) can supply the missing fields, but its Enterprise SKU (rating/price/opening-hours fields) and separately-billed photo media (~$7/1k) make an unthrottled or client-side integration expensive and abusable.

## Decision

We will enrich venue previews on demand via a server-proxied Google Places (New) **Text Search** call, keyed off the venue's name + coordinates (and its Foursquare id when the agent supplied one), plus a **Place Photos** media fetch for the first photo.

- **Server-only key.** `GOOGLE_PLACES_KEY` is read only in `apps/web/app/api/places/preview/route.ts` (a `GET` route authenticated the same way as the plan route: bearer `sessionToken` + `requireMember`); it is never sent to the browser. When unset, the route returns `{ ok: false, reason: "unavailable" }` (200) rather than erroring — the map/plan-card degrade to bare pin data, so a missing key is a capability gap, not an outage.
- **One call per miss, on click only.** Text Search runs with `pageSize: 1` and a 250 m `locationBias` circle around the venue's coordinates; the response's field mask requests only what the card renders. There is no prefetch — the route is called only when a user opens a preview.
- **Mismatch guard.** A haversine check rejects any Text Search result more than 500 m from the query point as `not_found`, rather than risk showing a same-named venue's photo from the wrong side of London.
- **In-process cache**, module-scope `Map`, keyed `fsq:<id>` when the agent supplied a Foursquare id or `geo:<name>|<lat>|<lng>` otherwise, capped at 500 entries with FIFO eviction. Both positive and `not_found` results cache for 24h; a transport failure (`unavailable`) caches for only 5 minutes, so a Google outage degrades gracefully without poisoning every venue for a full day.
- **`fsqPlaceId` threaded end-to-end** so the cache can key off it: `Venue.fsqPlaceId` (already fetched from ClickHouse) now survives `assemblePlanResult`/`publishFinalOverlay` in `room-agent.ts` into `PlanCandidate.venues[].fsqPlaceId` and `MapOverlay.pins[].placeId`, both optional so older persisted plan snapshots (predating this field) still parse. The room agent's `show_map` tool schema is unchanged — it stays strict (`additionalProperties: false`) with no `placeId` field, so mid-run model-painted pins simply have none; the geo fallback cache key covers them.
- **Popup, not a custom overlay**, for the same reason 0017 called out: the card must track its anchor as the camera moves. `mapboxgl-popup`'s default chrome (white bubble, tail, close button) is neutralized in `packages/ui/src/styles/globals.css` so the card supplies its own border/shadow; `z-index: 20` is required because remote-cursor `Marker`s (a separate phase) mount later in DOM order and would otherwise paint over it.

Alternatives considered and rejected:

- **Foursquare's own commercial Places API** (richer match to the existing venue source) — rejected for this pass: no existing account/billing relationship, whereas Google Places (New) is already verified against current docs and priced predictably per-call.
- **Client-side Google key** — rejected outright: an API key with Enterprise-SKU scope in browser JS is trivially harvested and abused; the proxy route is the only place that pattern is acceptable.
- **Postgres-backed cache** (survives deploys, shared across instances) — deferred as a documented upgrade path, not built now: the in-process `Map` is sufficient for a single-instance hackathon deployment, and a durable cache is a straightforward follow-up (a `place_previews` table keyed the same way, TTL enforced by a `expires_at` column) if/when the app runs multi-instance.

## Consequences

- Preview cost is bounded by clicks, not by data volume — no per-venue cost at plan-generation time, and the 24h/500-entry cache keeps repeat clicks (including across participants previewing the same winning venue) free after the first.
- The in-process cache does not survive a deploy/restart and is not shared across instances; acceptable now, tracked above as a Postgres upgrade path if the app scales beyond one instance.
- Two more optional fields (`fsqPlaceId` / `placeId`) now have to stay in sync across four type copies (`packages/tasks/src/trigger/analysis/types.ts`, `room-agent.ts`'s local `OverlayPin`, and `apps/web/lib/types.ts`'s `PlanCandidate`/`MapOverlay`) — same field-for-field-mirror convention the rest of the plan/overlay shapes already follow, not a new pattern.
- A wrong-venue photo is structurally prevented (mismatch guard) at the cost of some false negatives (`not_found` for venues Google's Text Search genuinely can't resolve near the given point) — judged the safer failure direction for a live multi-user room.
