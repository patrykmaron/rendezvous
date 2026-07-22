"use client"

import * as React from "react"

import {
  useOthersMapped,
  useSelf,
  useUpdateMyPresence,
} from "@liveblocks/react/suspense"
import { MapPinIcon } from "@phosphor-icons/react/dist/csr/MapPin"
import Map, {
  Layer,
  Marker,
  Popup,
  Source,
  type LayerProps,
  type MapMouseEvent,
  type MapRef,
  type MarkerEvent,
} from "react-map-gl/mapbox"
import { useTheme } from "next-themes"

import "mapbox-gl/dist/mapbox-gl.css"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import { setOrigin } from "@/app/actions/origin"
import { LiveCursor } from "@/components/presence/live-cursor"
import type { MapOverlay, OriginPoint, PlacePreviewTarget } from "@/lib/types"

import { PlacePreviewCard } from "./place-preview-card"
import { TravelPrefsPopover } from "./travel-prefs-popover"
import { useOrbit, type OrbitPoint } from "./use-orbit"

// Publicly-inlined at build (NEXT_PUBLIC_*); a client component may read it.
const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN

// The Shard, pitched for its 3D mesh — the room's attract-mode default before
// any origins have loaded (origins arrive async; this is a handoff, not a
// correction, so we always start here rather than a flatter "safe" view).
// Fallback if The Shard's 3D mesh turns out to be absent in Standard:
// { longitude: -0.088, latitude: 51.507, zoom: 14.6, pitch: 60 } (Tower Bridge / City skyline)
const INITIAL_VIEW_STATE = {
  longitude: -0.0865,
  latitude: 51.5045,
  zoom: 15.7,
  pitch: 62,
  bearing: -30,
} as const

const STANDARD_STYLE = "mapbox://styles/mapbox/standard"

// Defined once, OUTSIDE the component: react-map-gl shallow-diffs style props
// on every render, so an inline object would rebuild the layer each time. The
// `color` property is read per-feature from the routes FeatureCollection.
const ROUTE_LAYER: LayerProps = {
  id: "route-lines",
  type: "line",
  layout: { "line-join": "round", "line-cap": "round" },
  paint: {
    "line-color": ["get", "color"],
    "line-width": 3,
    "line-opacity": 0.85,
  },
  // Above land/water, below 3D buildings + labels. Drop if 3D-building
  // occlusion of route lines looks bad against Standard's building layer.
  slot: "middle",
}

function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?"
}

/** A participant's start-point pin: coloured circle + white initial + tail. */
function OriginMarker({ name, color }: { name: string; color: string }) {
  return (
    <div className="flex cursor-default flex-col items-center" title={name}>
      <div
        className="flex size-7 items-center justify-center rounded-full text-[11px] font-semibold text-white shadow-md ring-2 ring-white/70"
        style={{ backgroundColor: color }}
      >
        {initialOf(name)}
      </div>
      <div
        style={{
          width: 0,
          height: 0,
          borderLeft: "5px solid transparent",
          borderRight: "5px solid transparent",
          borderTop: `7px solid ${color}`,
        }}
      />
    </div>
  )
}

/** An agent-proposed candidate spot: a ranked, neutral-accent badge. */
function CandidatePin({ rank, label }: { rank?: number; label?: string }) {
  return (
    <div
      className="flex size-6 cursor-default items-center justify-center rounded-full bg-foreground text-[11px] font-semibold text-background shadow-md ring-2 ring-background"
      title={label}
    >
      {rank ?? "•"}
    </div>
  )
}

/** A concrete venue on a candidate: a smaller dot. Clickable — see the
 * venue-pin Marker's onClick in RoomMap, which opens a place-preview card. */
function VenuePin({ color, label }: { color?: string; label?: string }) {
  return (
    <div
      className="size-3 cursor-pointer rounded-full bg-foreground/70 shadow ring-1 ring-background transition-transform hover:scale-150"
      style={color ? { backgroundColor: color } : undefined}
      title={label}
    />
  )
}

export function RoomMap({
  roomId,
  session,
  origins,
  overlay,
  preview,
  onPreviewChange,
  controlsRaised = false,
}: {
  roomId: string
  session: { participantId: string; sessionToken: string; color: string }
  origins: OriginPoint[]
  overlay: MapOverlay
  preview: PlacePreviewTarget | null
  onPreviewChange: (preview: PlacePreviewTarget | null) => void
  // Lift the bottom-right set-origin cluster above the venue carousel when it's
  // visible (a sibling overlay in #map-pane), so the two never overlap. Only
  // raised on md+ — on mobile the carousel sits higher (above the FAB) and the
  // cluster stays clear at bottom-3.
  controlsRaised?: boolean
}) {
  const mapRef = React.useRef<MapRef>(null)
  // react-map-gl creates the GL instance asynchronously (a dynamic
  // `import('mapbox-gl')` resolves a commit or more after mount), so
  // `mapRef.current` is null on the first render(s). This React state — set in
  // the `onLoad` handler below — is the signal the camera effects (orbit,
  // fitBounds, focus flyTo) key on, because a ref read never retriggers an
  // effect and the instance can appear late on a slower production load.
  const [mapLoaded, setMapLoaded] = React.useState(false)
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme === "dark"

  // Standard's light preset is a basemap import-config property, not a style
  // prop react-map-gl diffs on `<Map>` — flip it imperatively so the theme
  // toggle never reloads the whole style. `mapStyle` below stays constant.
  React.useEffect(() => {
    mapRef.current?.setConfigProperty(
      "basemap",
      "lightPreset",
      dark ? "dusk" : "day"
    )
  }, [dark])

  // With `reuseMaps`, the underlying GL instance can be recycled from a
  // previous mount and carry a stale config — re-apply once the (possibly
  // reused) map is ready, so the correct preset always wins over whatever it
  // had before.
  const handleMapLoad = React.useCallback(() => {
    mapRef.current?.setConfigProperty(
      "basemap",
      "lightPreset",
      dark ? "dusk" : "day"
    )
    // Flip the state the camera effects key on. Safe to call on every (reused)
    // load — setState bails when the value is unchanged.
    setMapLoaded(true)
  }, [dark])

  const self = useSelf()
  const myName = self?.info.name ?? "You"
  const updateMyPresence = useUpdateMyPresence()

  // Other participants' live cursors. The selector returns a fresh object each
  // call; Liveblocks shallow-compares, so unchanged cursors don't re-render.
  const cursors = useOthersMapped((other) => ({
    cursor: other.presence.cursor,
    color: other.presence.color,
    name: other.info?.name,
  }))

  // Set-origin mode + optimistic local pin for *this* participant. `localOrigin`
  // shadows the props value for my own marker so the pin lands instantly on
  // click; the authoritative value arrives moments later via the origin:update
  // broadcast (which the shell folds back into `origins`).
  const [settingOrigin, setSettingOrigin] = React.useState(false)
  const [localOrigin, setLocalOrigin] = React.useState<{
    lat: number
    lng: number
  } | null>(null)
  const [originError, setOriginError] = React.useState<string | null>(null)
  const [, startTransition] = React.useTransition()

  const originsToRender = React.useMemo<OriginPoint[]>(() => {
    if (!localOrigin) return origins
    const withoutMine = origins.filter(
      (o) => o.participantId !== session.participantId
    )
    return [
      ...withoutMine,
      {
        participantId: session.participantId,
        name: myName,
        color: session.color,
        lat: localOrigin.lat,
        lng: localOrigin.lng,
      },
    ]
  }, [origins, localOrigin, session.participantId, session.color, myName])

  // My authoritative origin entry (carries saved travel prefs) — gates the
  // travel-prefs popover. From `origins` (not originsToRender, whose optimistic
  // local pin has no prefs), so it appears once the durable row is in the list.
  const myOrigin = origins.find(
    (o) => o.participantId === session.participantId
  )

  // Publish my own cursor as I move; clear it when I leave the map. No manual
  // throttle needed — Liveblocks coalesces presence writes to the provider's
  // `throttle` interval.
  const handleMouseMove = React.useCallback(
    (event: MapMouseEvent) => {
      updateMyPresence({
        cursor: {
          surface: "map",
          lng: event.lngLat.lng,
          lat: event.lngLat.lat,
        },
      })
    },
    [updateMyPresence]
  )
  const handleMouseLeave = React.useCallback(() => {
    updateMyPresence({ cursor: null })
  }, [updateMyPresence])

  const handleMapClick = React.useCallback(
    (event: MapMouseEvent) => {
      if (!settingOrigin) {
        // A click that reaches here (rather than a venue-pin Marker's own
        // handler) is on the map background — dismiss any open preview.
        onPreviewChange(null)
        return
      }
      const lat = event.lngLat.lat
      const lng = event.lngLat.lng
      setSettingOrigin(false)
      setOriginError(null)
      setLocalOrigin({ lat, lng }) // optimistic
      startTransition(async () => {
        const result = await setOrigin(session.sessionToken, roomId, {
          lat,
          lng,
        })
        if (!result.ok) {
          setLocalOrigin(null) // revert the optimistic pin
          setOriginError(result.error)
        }
      })
    },
    [settingOrigin, session.sessionToken, roomId, onPreviewChange]
  )

  // Fit the camera to all points. The bounds are memoized off the coordinate
  // set, so this recomputes (and the effect re-fits) only when origins/pins
  // actually change — cursor re-renders leave the memo identity stable.
  // Skipped for fewer than two points: a single origin would zoom absurdly far.
  // `singlePoint` is the one-point case, handed to useOrbit for its handoff fly.
  const {
    box: boundsBox,
    count: boundsCount,
    singlePoint,
  } = React.useMemo(() => {
    const points: Array<[number, number]> = []
    for (const o of originsToRender) points.push([o.lng, o.lat])
    for (const p of overlay.pins) points.push([p.lng, p.lat])

    let minLng = Infinity
    let minLat = Infinity
    let maxLng = -Infinity
    let maxLat = -Infinity
    for (const [lng, lat] of points) {
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
    }
    return {
      box: [
        [minLng, minLat],
        [maxLng, maxLat],
      ] as [[number, number], [number, number]],
      count: points.length,
      singlePoint:
        points.length === 1
          ? ({ lng: points[0]![0], lat: points[0]![1] } satisfies OrbitPoint)
          : null,
    }
  }, [originsToRender, overlay.pins])

  // The room has something to show once any origin, overlay pin, or agent
  // focus exists — drives when the attract-mode orbit stops (see useOrbit).
  const hasData =
    originsToRender.length > 0 ||
    overlay.pins.length > 0 ||
    overlay.focus != null

  // Must run before the fitBounds/focus effects below: the orbit cancels its
  // rAF loop in the same commit that delivers real data, so those effects
  // always take over an unclaimed camera rather than fighting the orbit for it.
  useOrbit(mapRef, { hasData, settingOrigin, singlePoint, mapLoaded })

  // `mapLoaded` is in the deps (and the guard) so origins/pins that resolved
  // BEFORE the async map instance existed still fit once it loads — reading
  // `mapRef.current` alone would silently no-op on that first pass.
  React.useEffect(() => {
    const map = mapRef.current
    if (!mapLoaded || !map || boundsCount < 2) return
    map.fitBounds(boundsBox, {
      padding: 60,
      maxZoom: 14,
      duration: 1200,
      pitch: 45,
      bearing: 0,
    })
  }, [boundsBox, boundsCount, mapLoaded])

  // Fly to an agent-requested focus point when it changes (or once the map
  // loads, for a focus that resolved before the instance existed).
  const focusLat = overlay.focus?.lat
  const focusLng = overlay.focus?.lng
  const focusZoom = overlay.focus?.zoom
  React.useEffect(() => {
    const map = mapRef.current
    if (!mapLoaded || !map || focusLat === undefined || focusLng === undefined)
      return
    map.flyTo({
      center: [focusLng, focusLat],
      zoom: focusZoom ?? map.getZoom(),
      duration: 800,
    })
  }, [focusLat, focusLng, focusZoom, mapLoaded])

  if (!MAPBOX_TOKEN) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
        Set NEXT_PUBLIC_MAPBOX_TOKEN to enable the map.
      </div>
    )
  }

  return (
    <div className="relative h-full w-full">
      <Map
        ref={mapRef}
        reuseMaps
        mapboxAccessToken={MAPBOX_TOKEN}
        initialViewState={INITIAL_VIEW_STATE}
        style={{ width: "100%", height: "100%" }}
        mapStyle={STANDARD_STYLE}
        antialias
        config={{ basemap: { lightPreset: dark ? "dusk" : "day" } }}
        maxPitch={85}
        cursor={settingOrigin ? "crosshair" : undefined}
        onLoad={handleMapLoad}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleMapClick}
      >
        {overlay.routes ? (
          <Source id="routes" type="geojson" data={overlay.routes}>
            <Layer {...ROUTE_LAYER} />
          </Source>
        ) : null}

        {originsToRender.map((origin) => (
          <Marker
            key={origin.participantId}
            longitude={origin.lng}
            latitude={origin.lat}
            anchor="bottom"
          >
            <OriginMarker
              name={
                origin.label ? `${origin.name} · ${origin.label}` : origin.name
              }
              color={origin.color}
            />
          </Marker>
        ))}

        {overlay.pins.map((pin) => (
          <Marker
            key={pin.id}
            longitude={pin.lng}
            latitude={pin.lat}
            anchor="center"
            onClick={
              pin.kind === "venue"
                ? (event: MarkerEvent<MouseEvent>) => {
                    // Marker clicks bubble to the map's own onClick
                    // (handleMapClick), which would otherwise read this as a
                    // background click and immediately clear the preview it
                    // just opened.
                    event.originalEvent.stopPropagation()
                    onPreviewChange({
                      id: pin.id,
                      name: pin.label ?? "Venue",
                      lat: pin.lat,
                      lng: pin.lng,
                      fsqPlaceId: pin.placeId,
                      googlePlaceId: pin.googlePlaceId,
                    })
                  }
                : undefined
            }
          >
            {pin.kind === "candidate" ? (
              <CandidatePin rank={pin.rank} label={pin.label} />
            ) : (
              <VenuePin color={pin.color} label={pin.label} />
            )}
          </Marker>
        ))}

        {cursors.map(([connectionId, data]) =>
          data.cursor?.surface === "map" ? (
            <Marker
              key={connectionId}
              longitude={data.cursor.lng}
              latitude={data.cursor.lat}
              anchor="top-left"
              style={{ pointerEvents: "none" }}
            >
              <LiveCursor color={data.color} name={data.name ?? "Guest"} />
            </Marker>
          ) : null
        )}

        {preview ? (
          <Popup
            longitude={preview.lng}
            latitude={preview.lat}
            anchor="bottom"
            offset={14}
            closeButton={false}
            maxWidth="none"
            onClose={() => onPreviewChange(null)}
          >
            <PlacePreviewCard
              target={preview}
              roomId={roomId}
              sessionToken={session.sessionToken}
            />
          </Popup>
        ) : null}
      </Map>

      {originsToRender.length === 0 ? (
        <div className="pointer-events-none absolute inset-x-0 top-4 z-10 flex justify-center px-4">
          <p className="max-w-xs rounded-none border border-border bg-background/95 px-3 py-1.5 text-center text-xs text-muted-foreground shadow-md">
            Click &ldquo;Set my start point&rdquo; to begin
          </p>
        </div>
      ) : null}

      <div
        className={cn(
          "absolute right-3 z-10 flex flex-col items-end gap-2 transition-[bottom] duration-200",
          controlsRaised ? "bottom-3 md:bottom-[13.5rem]" : "bottom-3"
        )}
      >
        {originError ? (
          <p className="max-w-[220px] rounded-md bg-background/90 px-2.5 py-1.5 text-xs text-destructive shadow-md ring-1 ring-border">
            {originError}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          {/* Prefs edit the routing pipeline, so they only appear once this
              member actually has a start point on the authenticated list. */}
          {myOrigin ? (
            <TravelPrefsPopover
              roomId={roomId}
              sessionToken={session.sessionToken}
              mine={myOrigin}
            />
          ) : null}
          <Button
            type="button"
            variant={settingOrigin ? "default" : "outline"}
            size="sm"
            className="shadow-md"
            onClick={() => {
              setOriginError(null)
              setSettingOrigin((v) => !v)
            }}
          >
            <MapPinIcon weight="fill" />
            {settingOrigin ? "Click the map…" : "Set my start point"}
          </Button>
        </div>
      </div>
    </div>
  )
}
