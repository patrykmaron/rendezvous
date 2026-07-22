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
   *  map (origins + pins combined), else null. Used only for the handoff fly
   *  when data arrives mid-orbit — with zero points the existing focus effect
   *  owns the camera, and with two-plus the fitBounds effect does. */
  singlePoint: OrbitPoint | null
}

/**
 * Attract-mode camera orbit for an otherwise-empty room. Starts a slow,
 * client-only rotation around the initial view once the map has loaded, and
 * stops it permanently (per mount, no resume) on the first sign of real
 * input, room data, or set-origin mode — or never starts it at all if the
 * user prefers reduced motion.
 *
 * All animation state lives in refs, not React state: a per-frame
 * `rotateTo` call must never trigger a re-render.
 */
export function useOrbit(
  mapRef: React.RefObject<MapRef | null>,
  { hasData, settingOrigin, singlePoint }: UseOrbitOptions
) {
  const rafIdRef = React.useRef<number | null>(null)
  const orbitingRef = React.useRef(false)
  // One-way latch: once true, the orbit never (re)starts for this mount.
  const stoppedRef = React.useRef(false)
  const startBearingRef = React.useRef(0)
  const startTimeRef = React.useRef<number | null>(null)

  // Mirrors the latest props into a ref so the map's "load" listener — which
  // may fire long after mount, racing real data arriving — reads current
  // values instead of the ones closed over when it was registered. Written
  // only inside an effect (after commit), never during render.
  const latestRef = React.useRef({ hasData, settingOrigin, singlePoint })
  React.useEffect(() => {
    latestRef.current = { hasData, settingOrigin, singlePoint }
  })

  // Stable across the mount: touches only refs, so it's safe to share
  // between the load/input listeners below and the data-flip effect further
  // down. Returns whether an orbit was actually cancelled (for the handoff
  // decision), and is a no-op after the first call.
  const stop = React.useCallback(() => {
    if (stoppedRef.current) return false
    const wasOrbiting = orbitingRef.current
    stoppedRef.current = true
    orbitingRef.current = false
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    return wasOrbiting
  }, [])

  // Mount-once: waits for the map to load, then (unless data/set-origin mode
  // already won the race, or the user prefers reduced motion) starts the
  // orbit loop and attaches the listeners that permanently stop it on real
  // input. Reruns only if `mapRef` itself changes, which it never does.
  React.useEffect(() => {
    const map = mapRef.current
    if (!map) return

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

    function handleRealInput() {
      stop()
    }

    function handleLoad() {
      // Mouse/touch/wheel are the only "real input" signals that stop the
      // orbit — our own per-frame `rotateTo` also fires move/rotate camera
      // events, so listening to those would stop the orbit on its own frame.
      map!.on("mousedown", handleRealInput)
      map!.on("touchstart", handleRealInput)
      map!.on("wheel", handleRealInput)

      const { hasData: hd, settingOrigin: so } = latestRef.current
      if (stoppedRef.current || hd || so) return
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        stoppedRef.current = true // never start; static pitched view
        return
      }
      orbitingRef.current = true
      startBearingRef.current = map!.getBearing()
      startTimeRef.current = null
      rafIdRef.current = requestAnimationFrame(frame)
    }

    if (map.loaded()) {
      handleLoad()
    } else {
      map.on("load", handleLoad)
    }

    return () => {
      map.off("load", handleLoad)
      map.off("mousedown", handleRealInput)
      map.off("touchstart", handleRealInput)
      map.off("wheel", handleRealInput)
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
    // Mount-once by design (see comment above); `mapRef` is a stable ref
    // object, and `stop` (closed over via `handleRealInput`) never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapRef])

  // Permanent stop when data arrives or set-origin mode is entered. Handoff:
  // only when data (not set-origin mode) interrupted an orbit in progress,
  // and there is exactly one point to fly to.
  React.useEffect(() => {
    if (!hasData && !settingOrigin) return
    const wasOrbiting = stop()
    if (wasOrbiting && hasData && !settingOrigin && singlePoint) {
      mapRef.current?.flyTo({
        center: [singlePoint.lng, singlePoint.lat],
        zoom: HANDOFF_ZOOM,
        pitch: HANDOFF_PITCH,
        bearing: 0,
        duration: HANDOFF_DURATION_MS,
      })
    }
  }, [hasData, settingOrigin, singlePoint, stop, mapRef])
}
