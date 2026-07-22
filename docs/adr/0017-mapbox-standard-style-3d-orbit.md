# 0017. Mapbox Standard style with a 3D attract-mode orbit

**Status:** Accepted
**Date:** 2026-07-22

## Context

[0016](0016-mapbox-gl-for-the-map-surface.md) picked `dark-v11`/`light-v11` as the basemap, swapped by string on every `next-themes` toggle — a full style reload each time, and a flat 2D surface with no landmark geometry. A polish pass wants the room to read as a place, not a flat basemap, from the moment it loads — including the common case where nobody has dropped a start point yet and the map would otherwise sit empty and static.

Mapbox Standard (`mapbox://styles/mapbox/standard`) ships built-in 3D landmarks and buildings, and exposes its light preset (`dawn`/`day`/`dusk`/`night`) as a runtime **import config property** rather than a style URL — themeable without a style swap.

## Decision

We will switch the basemap from `dark-v11`/`light-v11` to **Mapbox Standard**, and add a client-only 3D **attract-mode orbit** for empty rooms.

- **Style + theme.** `mapStyle` is now the single constant `mapbox://styles/mapbox/standard`, set once via `<Map>`'s init-only `config={{ basemap: { lightPreset } }}` prop. `next-themes`'s `resolvedTheme` maps light→`"day"`, dark→`"dusk"` (no `"dawn"`/`"night"` — those don't correspond to either app theme). Runtime theme flips call `mapRef.current.setConfigProperty("basemap", "lightPreset", ...)` imperatively — no more style reload on toggle. This amends 0016's "Theme-driven style swap" bullet by reference; 0016 itself is not edited. Because `<Map reuseMaps>` can recycle a GL instance across mounts with a stale config baked in, the same `setConfigProperty` call also runs from `<Map>`'s `onLoad`, not just the theme effect — the pair together, not either alone, is the authoritative path.
- **Initial view: The Shard**, pitched (`zoom: 15.7, pitch: 62, bearing: -30`) to show its 3D mesh, replacing the old flat Charing Cross overview. Origins load asynchronously after mount regardless of basemap choice, so this was already a "fly in once data arrives" flow, not a static default — landing somewhere with presence rather than a generic city overview costs nothing extra.
- **Attract-mode orbit** (`apps/web/components/map/use-orbit.ts`): once the map loads, if the room has no origins/pins/focus yet, nobody is in set-origin mode, and the user hasn't asked for reduced motion, the camera slowly rotates around the Shard (~54s/revolution, `requestAnimationFrame` + `rotateTo(bearing, { duration: 0 })`). It stops permanently — one latch per mount, no resume timer — on the first real `mousedown`/`touchstart`/`wheel`, on room data arriving, or on entering set-origin mode; it never starts at all under `prefers-reduced-motion: reduce`. Listening only to real-input events (not `move`/`rotate`) matters because the orbit's own per-frame `rotateTo` fires those same camera events — subscribing to them would make the orbit stop itself on its own first frame. When data arrives mid-orbit and it's a single point, the orbit hands off with one `flyTo` to that point; for two-plus points the existing fitBounds effect (now unwinding to `pitch: 45, bearing: 0`) already owns the camera, so the orbit does nothing.
- **Route layer gets `slot: "middle"`** — Standard's slot system orders custom layers relative to its built-ins; `"middle"` sits above land/water and below 3D buildings and labels, matching the previous (style-implicit) draw order.

Alternative considered: keep the flat `-v11` styles and add a manual `pitch`/`bearing` for visual interest without touching the style — rejected because it still leaves the surface a flat 2D texture with no real building/landmark geometry, i.e. the pitch would create depth without anything to look at.

## Consequences

- Standard's 3D tiles (landmarks, extruded buildings) cost more to render than the flat `-v11` styles; acceptable since the map is the app's primary surface, but worth watching on lower-end devices given `maxPitch={85}` now permits steep, tile-heavy angles.
- The route layer is now coupled to Standard's slot ordering (`slot: "middle"`); a future style change has to re-verify draw order, not just swap a URL.
- Framing on The Shard depends on its 3D mesh actually being present in Standard's landmark set — unverified at merge time. If it's absent, the same constants have a documented flat-skyline fallback (Tower Bridge/City, `pitch: 60`, no orbit-relevant landmark assumption) ready to drop in without redesigning the orbit or handoff logic.
- The orbit is a genuinely new moving-camera surface (`requestAnimationFrame` loop) that must be re-audited by any future feature touching camera control (e.g. a place-preview popup) to avoid two things driving `rotateTo`/`flyTo` at once.
