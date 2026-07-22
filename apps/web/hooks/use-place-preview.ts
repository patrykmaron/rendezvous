"use client"

import * as React from "react"

import type { PlacePreview, PlacePreviewResponse } from "@/lib/place-preview"
import type { PlacePreviewTarget } from "@/lib/types"

// Session-lifetime client cache of preview responses, keyed by the target's
// stable identity. The server route already caches 24h and coalesces in-flight
// requests (ADR 0018/0020); this layer keeps a re-activated carousel card (or a
// re-opened popup) from paying even one round-trip. Shared across every hook
// instance (module scope).
const CACHE = new Map<string, PlacePreviewResponse>()

function cacheKey(t: PlacePreviewTarget): string {
  return [
    t.id,
    t.name,
    t.lat,
    t.lng,
    t.googlePlaceId ?? "",
    t.fsqPlaceId ?? "",
  ].join("|")
}

export type PlacePreviewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; place: PlacePreview }
  | { kind: "unavailable" }

/**
 * Lazily fetches a Google Places preview for one target through the server
 * route (ADR 0018) — never Google directly. `target === null` stays idle and
 * fires nothing (so the carousel can subscribe only the ACTIVE card). Debounces
 * `debounceMs` (default 300) before the fetch so skimming cards costs no calls,
 * caches results client-side by target identity, and aborts the in-flight fetch
 * whenever the target changes or the component unmounts. Used by the venue
 * carousel (active card only) and PlacePreviewCard (debounceMs: 0).
 */
export function usePlacePreview(
  target: PlacePreviewTarget | null,
  roomId: string,
  sessionToken: string,
  opts?: { debounceMs?: number }
): PlacePreviewState {
  const debounceMs = opts?.debounceMs ?? 300
  const [state, setState] = React.useState<PlacePreviewState>({ kind: "idle" })

  // Depend on the target's primitive fields (its stable content), not the
  // object identity — which changes every render — so the fetch fires only when
  // the target actually changes. `key` is their cache-keyed join.
  const name = target?.name
  const lat = target?.lat
  const lng = target?.lng
  const gp = target?.googlePlaceId
  const fsq = target?.fsqPlaceId
  const key = target ? cacheKey(target) : null

  React.useEffect(() => {
    if (key === null || name === undefined || lat === undefined || lng === undefined) {
      setState({ kind: "idle" })
      return
    }

    const cached = CACHE.get(key)
    if (cached) {
      setState(
        cached.ok ? { kind: "ok", place: cached.place } : { kind: "unavailable" }
      )
      return
    }

    setState({ kind: "loading" })
    const controller = new AbortController()
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        roomId,
        name,
        lat: String(lat),
        lng: String(lng),
      })
      if (gp) params.set("gp", gp)
      if (fsq) params.set("fsq", fsq)

      fetch(`/api/places/preview?${params.toString()}`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
        signal: controller.signal,
      })
        .then((res) =>
          res.ok ? (res.json() as Promise<PlacePreviewResponse>) : null
        )
        .then((data) => {
          const resp: PlacePreviewResponse =
            data?.ok === true ? data : { ok: false, reason: "unavailable" }
          CACHE.set(key, resp)
          setState(
            resp.ok ? { kind: "ok", place: resp.place } : { kind: "unavailable" }
          )
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === "AbortError") return
          setState({ kind: "unavailable" })
        })
    }, debounceMs)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [key, name, lat, lng, gp, fsq, roomId, sessionToken, debounceMs])

  return state
}
