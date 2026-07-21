"use client"

import * as React from "react"

import { useOthersMapped, useSelf, useUpdateMyPresence } from "@liveblocks/react/suspense"
import { MapPinIcon } from "@phosphor-icons/react/dist/csr/MapPin"
import Map, {
  Layer,
  Marker,
  Source,
  type LayerProps,
  type MapMouseEvent,
  type MapRef,
} from "react-map-gl/mapbox"
import { useTheme } from "next-themes"

import "mapbox-gl/dist/mapbox-gl.css"

import { Button } from "@workspace/ui/components/button"

import { setOrigin } from "@/app/actions/origin"
import type { MapOverlay, OriginPoint } from "@/lib/types"

// Publicly-inlined at build (NEXT_PUBLIC_*); a client component may read it.
const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN

// Central London (Charing Cross), zoomed to show most of the city.
const INITIAL_VIEW_STATE = {
  longitude: -0.1276,
  latitude: 51.5072,
  zoom: 11,
} as const

const DARK_STYLE = "mapbox://styles/mapbox/dark-v11"
const LIGHT_STYLE = "mapbox://styles/mapbox/light-v11"

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
}

// How often a moving cursor is published to presence (ms). Cheap and smooth
// without flooding the realtime channel.
const CURSOR_THROTTLE_MS = 50

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

/** Another participant's live cursor: a small, translucent coloured dot. */
function CursorDot({ color, name }: { color?: string; name?: string }) {
  return (
    <div
      className="size-2.5 rounded-full ring-1 ring-white/50"
      style={{ backgroundColor: color ?? "#888", opacity: 0.6 }}
      title={name}
    />
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

/** A concrete venue on a candidate: a smaller dot. */
function VenuePin({ color, label }: { color?: string; label?: string }) {
  return (
    <div
      className="size-3 cursor-default rounded-full bg-foreground/70 shadow ring-1 ring-background"
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
}: {
  roomId: string
  session: { participantId: string; sessionToken: string; color: string }
  origins: OriginPoint[]
  overlay: MapOverlay
}) {
  const mapRef = React.useRef<MapRef>(null)
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme === "dark"

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

  // Publish my own cursor as I move, throttled; clear it when I leave the map.
  const lastCursorSent = React.useRef(0)
  const handleMouseMove = React.useCallback(
    (event: MapMouseEvent) => {
      const now = Date.now()
      if (now - lastCursorSent.current < CURSOR_THROTTLE_MS) return
      lastCursorSent.current = now
      updateMyPresence({
        cursor: { lng: event.lngLat.lng, lat: event.lngLat.lat },
      })
    },
    [updateMyPresence]
  )
  const handleMouseLeave = React.useCallback(() => {
    updateMyPresence({ cursor: null })
  }, [updateMyPresence])

  const handleMapClick = React.useCallback(
    (event: MapMouseEvent) => {
      if (!settingOrigin) return
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
    [settingOrigin, session.sessionToken, roomId]
  )

  // Fit the camera to all points. The bounds are memoized off the coordinate
  // set, so this recomputes (and the effect re-fits) only when origins/pins
  // actually change — cursor re-renders leave the memo identity stable.
  // Skipped for fewer than two points: a single origin would zoom absurdly far.
  const { box: boundsBox, count: boundsCount } = React.useMemo(() => {
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
    }
  }, [originsToRender, overlay.pins])

  React.useEffect(() => {
    const map = mapRef.current
    if (!map || boundsCount < 2) return
    map.fitBounds(boundsBox, { padding: 60, maxZoom: 14, duration: 800 })
  }, [boundsBox, boundsCount])

  // Fly to an agent-requested focus point when it changes.
  const focusLat = overlay.focus?.lat
  const focusLng = overlay.focus?.lng
  const focusZoom = overlay.focus?.zoom
  React.useEffect(() => {
    const map = mapRef.current
    if (!map || focusLat === undefined || focusLng === undefined) return
    map.flyTo({
      center: [focusLng, focusLat],
      zoom: focusZoom ?? map.getZoom(),
      duration: 800,
    })
  }, [focusLat, focusLng, focusZoom])

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
        mapStyle={dark ? DARK_STYLE : LIGHT_STYLE}
        cursor={settingOrigin ? "crosshair" : undefined}
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
              name={origin.label ? `${origin.name} · ${origin.label}` : origin.name}
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
          >
            {pin.kind === "candidate" ? (
              <CandidatePin rank={pin.rank} label={pin.label} />
            ) : (
              <VenuePin color={pin.color} label={pin.label} />
            )}
          </Marker>
        ))}

        {cursors.map(([connectionId, data]) =>
          data.cursor ? (
            <Marker
              key={connectionId}
              longitude={data.cursor.lng}
              latitude={data.cursor.lat}
              anchor="center"
            >
              <CursorDot color={data.color} name={data.name} />
            </Marker>
          ) : null
        )}
      </Map>

      <div className="absolute right-3 bottom-3 z-10 flex flex-col items-end gap-2">
        {originError ? (
          <p className="max-w-[220px] rounded-md bg-background/90 px-2.5 py-1.5 text-xs text-destructive shadow-md ring-1 ring-border">
            {originError}
          </p>
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
  )
}
