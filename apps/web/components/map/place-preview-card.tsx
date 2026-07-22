"use client"

import * as React from "react"

import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut"
import { StarIcon } from "@phosphor-icons/react/dist/csr/Star"

import { cn } from "@workspace/ui/lib/utils"

import type { PlacePreview, PlacePreviewResponse } from "@/lib/place-preview"
import type { PlacePreviewTarget } from "@/lib/types"

// Flat, bordered container matching plan-card's visual language (no rounded
// corners) — see apps/web/components/chat/plan-card.tsx.
const CONTAINER_CLASS =
  "w-64 border border-border bg-card text-card-foreground shadow-lg"

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; place: PlacePreview }
  | { kind: "unavailable" }

function CategoryChip({ category }: { category?: string }) {
  if (!category) return null
  return (
    <span className="inline-flex w-fit items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
      {category}
    </span>
  )
}

function SkeletonCard() {
  return (
    <div className={cn(CONTAINER_CLASS, "animate-pulse overflow-hidden")}>
      <div className="h-32 w-full bg-muted" />
      <div className="flex flex-col gap-2 p-3">
        <div className="h-3 w-3/4 bg-muted" />
        <div className="h-3 w-1/2 bg-muted" />
      </div>
    </div>
  )
}

function FallbackCard({ target }: { target: PlacePreviewTarget }) {
  // Even when Google can't resolve the venue (e.g. a stale Foursquare entry that
  // no longer exists), give the user an action: a zero-cost Google Maps search
  // link built from the pin's own name + coords (ADR 0020).
  const mapsQuery = encodeURIComponent(
    `${target.name} ${target.lat},${target.lng}`
  )
  return (
    <div className={cn(CONTAINER_CLASS, "flex flex-col gap-1.5 p-3")}>
      <span className="truncate text-sm font-medium">{target.name}</span>
      <CategoryChip category={target.category} />
      <p className="text-xs text-muted-foreground">Preview unavailable</p>
      <a
        href={`https://www.google.com/maps/search/?api=1&query=${mapsQuery}`}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-0.5 flex items-center gap-1 text-xs text-primary hover:underline"
      >
        Search on Google Maps
        <ArrowSquareOutIcon className="size-3" />
      </a>
    </div>
  )
}

function PlaceCard({
  place,
  target,
}: {
  place: PlacePreview
  target: PlacePreviewTarget
}) {
  const [photoFailed, setPhotoFailed] = React.useState(false)
  const showPhoto = place.photoUrl !== null && !photoFailed

  return (
    <div className={cn(CONTAINER_CLASS, "overflow-hidden")}>
      {showPhoto ? (
        // Google's googleusercontent CDN photo — not a local/optimizable
        // asset next/image can handle, and skipping it avoids configuring
        // remotePatterns for a domain that varies per photo.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={place.photoUrl!}
          alt=""
          className="h-32 w-full object-cover"
          onError={() => setPhotoFailed(true)}
        />
      ) : null}

      <div className="flex flex-col gap-1.5 p-3">
        <span className="truncate text-sm font-medium">{place.name}</span>

        {place.rating !== null ? (
          <div className="flex items-center gap-1 text-xs">
            <StarIcon weight="fill" className="size-3.5 text-amber-500" />
            <span className="font-medium tabular-nums">{place.rating}</span>
            {place.userRatingCount !== null ? (
              <span className="text-muted-foreground tabular-nums">
                ({place.userRatingCount.toLocaleString()})
              </span>
            ) : null}
            {place.priceLevel ? (
              <span className="text-muted-foreground" title="Price level">
                {"£".repeat(place.priceLevel)}
              </span>
            ) : null}
          </div>
        ) : null}

        <CategoryChip category={target.category} />

        {place.address ? (
          <p className="truncate text-xs text-muted-foreground">
            {place.address}
          </p>
        ) : null}

        {place.businessStatus === "CLOSED_PERMANENTLY" ? (
          // A confirmed-dead venue: destructive badge, no open-now dot (ADR 0020).
          <span className="inline-flex w-fit items-center rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
            Permanently closed
          </span>
        ) : place.businessStatus === "CLOSED_TEMPORARILY" ? (
          <span className="inline-flex w-fit items-center rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-500">
            Temporarily closed
          </span>
        ) : place.openNow !== null ? (
          <div className="flex items-center gap-1.5 text-xs">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                place.openNow ? "bg-emerald-500" : "bg-red-500"
              )}
            />
            <span className="text-muted-foreground">
              {place.openNow ? "Open now" : "Closed"}
            </span>
          </div>
        ) : null}

        {place.googleMapsUri ? (
          <a
            href={place.googleMapsUri}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-0.5 flex items-center gap-1 text-xs text-primary hover:underline"
          >
            Open in Google Maps
            <ArrowSquareOutIcon className="size-3" />
          </a>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The clickable place-preview card rendered inside a mapbox Popup (see
 * room-map.tsx) or from a plan-card venue chip. Fetches once per `target`
 * change through the server-proxied Google Places route (ADR 0018) — never
 * calls Google directly, never prefetches. Three states: a skeleton while
 * loading, the enriched card on success, and a minimal fallback (pin data
 * only) when the preview is unavailable or the venue can't be matched.
 */
export function PlacePreviewCard({
  target,
  roomId,
  sessionToken,
}: {
  target: PlacePreviewTarget
  roomId: string
  sessionToken: string
}) {
  const [state, setState] = React.useState<LoadState>({ kind: "loading" })

  React.useEffect(() => {
    const controller = new AbortController()
    // Resets the card to its skeleton state whenever `target` changes, before
    // the fetch below resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ kind: "loading" })

    const params = new URLSearchParams({
      roomId,
      name: target.name,
      lat: String(target.lat),
      lng: String(target.lng),
    })
    // Prefer the exact Google-id lookup when we have it (ADR 0020); `fsq` still
    // travels for the Text Search fallback / cache-key when there's no gp.
    if (target.googlePlaceId) params.set("gp", target.googlePlaceId)
    if (target.fsqPlaceId) params.set("fsq", target.fsqPlaceId)

    fetch(`/api/places/preview?${params.toString()}`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
      signal: controller.signal,
    })
      .then((res) =>
        res.ok ? (res.json() as Promise<PlacePreviewResponse>) : null
      )
      .then((data) => {
        setState(
          data?.ok ? { kind: "ok", place: data.place } : { kind: "unavailable" }
        )
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return
        setState({ kind: "unavailable" })
      })

    return () => controller.abort()
  }, [
    roomId,
    sessionToken,
    target.id,
    target.name,
    target.lat,
    target.lng,
    target.fsqPlaceId,
    target.googlePlaceId,
  ])

  if (state.kind === "loading") return <SkeletonCard />
  if (state.kind === "unavailable") return <FallbackCard target={target} />
  return <PlaceCard place={state.place} target={target} />
}
