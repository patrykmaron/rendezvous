# 0016. Mapbox GL for the shared map surface

**Status:** Accepted — theme-swap mechanism amended by [0017](0017-mapbox-standard-style-3d-orbit.md)
**Date:** 2026-07-21

## Context

The room is built around a shared London map: participants drop start points, and the agent paints candidate areas, venue pins, and per-participant route lines over them ([0008](0008-h3-geospatial-grid.md), [0015](0015-room-agent-openai-tool-loop.md)). That surface needs vector tiles (smooth zoom over a dense city), first-class GeoJSON layers driven by per-feature properties (route lines coloured by their owner), imperative camera control (fly-to on a candidate click), and a light/dark basemap to match the app's theme. It renders entirely client-side — the map library touches `window`/`document` at module scope, so it can never be server-rendered.

## Decision

We will render the map with **Mapbox GL JS v3** (`mapbox-gl`), wrapped by **react-map-gl v8** (`react-map-gl/mapbox`).

- **Wrapper over raw GL.** `react-map-gl` gives declarative `<Map>`/`<Source>`/`<Layer>`/`<Marker>` components whose props reconcile against imperative GL calls, and a `MapRef` for the handful of imperative moments we do need (`flyTo` on focus). Origins, overlay pins, and route lines become React children fed from state, rather than a parallel imperative layer graph we hand-sync on every change. An escape hatch to the underlying map instance remains for anything the wrapper doesn't cover.
- **Token is a browser-exposed `pk.` public token**, inlined at build as `NEXT_PUBLIC_MAPBOX_TOKEN` (a client component reads it directly; the map cannot work otherwise). A public token is designed to ship to browsers, but it is still a spend-bearing credential, so it MUST be locked down in the Mapbox account with a **URL restriction** (allowed request origins) to the app's own domains, scoped to the minimum public styles/tiles it needs. When the token is absent the map degrades to an inline "Set NEXT_PUBLIC_MAPBOX_TOKEN to enable the map" placeholder rather than crashing. The secret (`sk.`) token is never used here.
- **Theme-driven style swap.** The basemap style is chosen from `next-themes`' `resolvedTheme` — `mapbox://styles/mapbox/dark-v11` vs `light-v11` — so the map tracks the app's light/dark toggle. Layer paint (route colours) is defined once at module scope and read per-feature via GL expressions (`["get", "color"]`), not rebuilt per render.

Alternatives considered: **MapLibre GL** with free tiles (no token, no per-load cost) — rejected for the hackathon because Mapbox's hosted vector styles and Studio basemaps are turnkey and the free tier covers demo traffic; the `react-map-gl/maplibre` entry point keeps this a low-cost reversal later. **Leaflet** — rejected: raster-tile heritage, weaker vector/GeoJSON styling and camera ergonomics for what is a data-viz surface, not a pin-drop widget.

## Consequences

- A browser-exposed token means the URL restriction in the Mapbox account is the real access control; forgetting it leaves the token usable from any origin. This lives in dashboard config, not the repo, so it is easy to miss on a new environment — documented here so it isn't.
- The map is loaded via `next/dynamic` with `ssr: false` and never participates in SSR; a loading spinner covers the client-only mount. Map code must stay free of any server-only import.
- Adopting `react-map-gl` couples us to its release cadence tracking Mapbox GL; a Mapbox GL major upgrade is gated on the wrapper supporting it.
- `mapbox-gl` ships a sizeable JS + CSS bundle (`mapbox-gl/dist/mapbox-gl.css` is imported by the map component); acceptable since the map is the primary surface and is code-split out of the initial route.
- Mapbox GL JS v3 remains under Mapbox's proprietary TOS (billed per map load); MapLibre stays the escape hatch if cost or licensing ever bites.
