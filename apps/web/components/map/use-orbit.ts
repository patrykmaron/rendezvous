import * as React from "react"

import type { MapRef } from "react-map-gl/mapbox"

// One degree of bearing per 150ms => a full 360° revolution every 54s
// (360 * 150 = 54_000ms). Slow enough to read as ambient, not spinning.
const ORBIT_MS_PER_DEGREE = 150

// Handoff camera move when exactly one origin/pin appears while orbiting.
const HANDOFF_ZOOM = 12.5
const HANDOFF_PITCH = 45
const HANDOFF_DURATION_MS = 1600

export type OrbitPoint = { lat: number; lng: number }

export type UseOrbitOptions = {
  /** True once the room has anything to show: origins, overlay pins, or an
   *  agent-requested focus. Orbit never starts once this is true, and
   *  permanently stops the moment it flips true while orbiting. */
  hasData: boolean
  /** True while the current participant is in "click to set my start point"
   *  mode. Orbit never starts, and permanently stops, while this is true. */
  settingOrigin: boolean
  /** The lone origin/pin coordinate when there is exactly one point on the
   *  map (origins + pins combined), else null. Used for the one-point camera
   *  handoff — with zero points the existing focus effect owns the camera, and
   *  with two-plus the fitBounds effect does. */
  singlePoint: OrbitPoint | null
  /** True once the map's `load` event has fired and `mapRef.current` is a live
   *  GL instance. react-map-gl creates the map ASYNCHRONOUSLY (a dynamic
   *  `import('mapbox-gl')` resolves a commit or more after mount), so reading
   *  `mapRef.current` at mount time sees null and a ref read never retriggers
   *  an effect. The setup + handoff effects below are therefore keyed on this
   *  React state, not on the ref — that's what makes them run on a production
   *  first load where the instance appears late. */
  mapLoaded: boolean
}

/**
 * Attract-mode camera orbit for an otherwise-empty room. Starts a slow,
 * client-only rotation around the initial view once the map has loaded, and
 * stops it permanently (per mount, no resume) on the first sign of real
 * input, room data, or set-origin mode — or never starts it at all if the
 * user prefers reduced motion. When exactly one point (a lone origin/pin)
 * arrives, it hands the camera off with a `flyTo` even if it never actually
 * orbited (reduced motion, or data that resolved before the map loaded), so a
 * single origin is never left stranded off-screen at the attract-mode close-up.
 *
 * All animation state lives in refs, not React state: a per-frame `rotateTo`
 * call must never trigger a re-render.
 */
export function useOrbit(
  mapRef: React.RefObject<MapRef | null>,
  { hasData, settingOrigin, singlePoint, mapLoaded }: UseOrbitOptions
) {
  const rafIdRef = React.useRef<number | null>(null)
  const orbitingRef = React.useRef(false)
  // One-way latch: once true, the orbit never (re)starts for this mount.
  const stoppedRef = React.useRef(false)
  // Set the moment the user grabs the map (mouse/touch/wheel). Gates the
  // one-point handoff so it never yanks a camera the user is already driving.
  const userInteractedRef = React.useRef(false)
  // One-way latch for the single-point handoff, so it flies at most once.
  const handoffDoneRef = React.useRef(false)
  const startBearingRef = React.useRef(0)
  const startTimeRef = React.useRef<number | null>(null)

  // Mirrors the latest data/mode props into a ref so the setup effect — which
  // runs only when `mapLoaded` flips, possibly long after those props last
  // changed — reads current values instead of the ones closed over at mount.
  // Written only inside an effect (after commit), never during render.
  const latestRef = React.useRef({ hasData, settingOrigin })
  React.useEffect(() => {
    latestRef.current = { hasData, settingOrigin }
  })

  // Stable across the mount: touches only refs, so it's safe to share between
  // the input listeners and the data-flip effect. A no-op after the first call.
  const stop = React.useCallback(() => {
    if (stoppedRef.current) return
    stoppedRef.current = true
    orbitingRef.current = false
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
  }, [])

  // Setup: keyed on `mapLoaded` (see UseOrbitOptions.mapLoaded) so it runs once
  // the GL instance actually exists. Attaches the real-input listeners and —
  // unless data / set-origin mode already won the race, or the user prefers
  // reduced motion — starts the orbit loop.
  React.useEffect(() => {
    const map = mapRef.current
    if (!mapLoaded || !map) return

    function frame(ts: number) {
      if (!orbitingRef.current) return
      if (startTimeRef.current === null) startTimeRef.current = ts
      const bearing =
        (startBearingRef.current +
          (ts - startTimeRef.current) / ORBIT_MS_PER_DEGREE) %
        360
      map!.rotateTo(bearing, { duration: 0 })
      rafIdRef.current = requestAnimationFrame(frame)
    }

    // Mouse/touch/wheel are the only "real input" signals that stop the orbit —
    // our own per-frame `rotateTo` also fires move/rotate camera events, so
    // listening to those would stop the orbit on its own frame.
    function handleRealInput() {
      userInteractedRef.current = true
      stop()
    }
    map.on("mousedown", handleRealInput)
    map.on("touchstart", handleRealInput)
    map.on("wheel", handleRealInput)

    const { hasData: hd, settingOrigin: so } = latestRef.current
    if (
      !stoppedRef.current &&
      !hd &&
      !so &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      orbitingRef.current = true
      startBearingRef.current = map.getBearing()
      startTimeRef.current = null
      rafIdRef.current = requestAnimationFrame(frame)
    }

    return () => {
      map.off("mousedown", handleRealInput)
      map.off("touchstart", handleRealInput)
      map.off("wheel", handleRealInput)
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
    // Keyed on mapLoaded; `mapRef` is a stable ref object and `stop` never
    // changes, so this runs exactly once — when the map instance appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapLoaded])

  // Permanent stop when data arrives or set-origin mode is entered, plus the
  // one-point camera handoff. Gated on `mapLoaded` so the flyTo lands on a live
  // instance rather than a null ref. Unlike the old `wasOrbiting` gate, the
  // handoff fires even when the orbit never ran (reduced motion, or a lone
  // origin that resolved before the map loaded); it is instead gated on the
  // user not having grabbed the camera, and it fires at most once.
  React.useEffect(() => {
    if (!mapLoaded) return
    if (settingOrigin) {
      stop()
      return
    }
    if (!hasData) return
    stop()
    if (!handoffDoneRef.current && !userInteractedRef.current && singlePoint) {
      handoffDoneRef.current = true
      const reduced = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches
      mapRef.current?.flyTo({
        center: [singlePoint.lng, singlePoint.lat],
        zoom: HANDOFF_ZOOM,
        pitch: HANDOFF_PITCH,
        bearing: 0,
        duration: reduced ? 0 : HANDOFF_DURATION_MS,
      })
    }
  }, [hasData, settingOrigin, singlePoint, mapLoaded, stop, mapRef])
}
