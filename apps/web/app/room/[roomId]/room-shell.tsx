"use client"

import * as React from "react"
import dynamic from "next/dynamic"

import {
  ClientSideSuspense,
  LiveblocksProvider,
  RoomProvider,
  useEventListener,
  useOthers,
  useSelf,
  useUpdateMyPresence,
} from "@liveblocks/react/suspense"
import { ChatCircleDotsIcon } from "@phosphor-icons/react/dist/csr/ChatCircleDots"
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check"
import { LinkIcon } from "@phosphor-icons/react/dist/csr/Link"
import { MapPinIcon } from "@phosphor-icons/react/dist/csr/MapPin"
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle"
import { SpinnerIcon } from "@phosphor-icons/react/dist/csr/Spinner"
import { XIcon } from "@phosphor-icons/react/dist/csr/X"

import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@workspace/ui/components/avatar"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Input } from "@workspace/ui/components/input"
import { Toaster, toast } from "@workspace/ui/components/sonner"
import { cn } from "@workspace/ui/lib/utils"

import { cellToLatLng, isValidCell } from "h3-js"

import { askAgent } from "@/app/actions/agent"
import { changeColor, joinRoom } from "@/app/actions/room"
import { decidePlan, toggleVote } from "@/app/actions/vote"
import { ChatPanel } from "@/components/chat/chat-panel"
import { VenueCarousel } from "@/components/map/venue-carousel"
import { EventTimeChip } from "@/components/room/event-time-chip"
import {
  CursorOverlay,
  useSurfaceCursor,
} from "@/components/presence/cursor-overlay"
import { useAgentToasts } from "@/hooks/use-agent-toasts"
import { usePlan } from "@/hooks/use-plan"
import { isFinalStatus, useRoomAgent } from "@/hooks/use-room-agent"
import { PARTICIPANT_COLORS } from "@/lib/colors"
import { candidateVenuePins } from "@/lib/plan-utils"
import {
  clearRoomSession,
  getRoomSession,
  setRoomSession,
  type RoomSession,
} from "@/lib/session"
import type {
  MapOverlay,
  OriginPoint,
  PlacePreviewTarget,
  PlanCandidate,
} from "@/lib/types"

// mapbox-gl touches `window`/`document` at module scope, so the map is loaded
// client-only (never server-rendered). ssr:false is valid here because this
// file is a Client Component (see Next.js lazy-loading guide).
const RoomMap = dynamic(
  () => import("@/components/map/room-map").then((m) => m.RoomMap),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
        <SpinnerIcon className="size-5 animate-spin" />
      </div>
    ),
  }
)

// Cap the presence stack so it can't grow unbounded on a crowded room; the
// rest collapse into a single "+N" badge (also keeps the mobile header from
// overflowing horizontally).
const MAX_VISIBLE_OTHERS = 4

function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?"
}

/** Solid-fill, initial-letter avatar tinted with a participant's colour. */
function InitialAvatar({
  name,
  color,
  title,
  className,
}: {
  name: string
  color: string
  title?: string
  className?: string
}) {
  return (
    <Avatar title={title} className={className}>
      <AvatarFallback
        className="text-[11px] font-semibold text-white"
        style={{ backgroundColor: color }}
      >
        {initialOf(name)}
      </AvatarFallback>
    </Avatar>
  )
}

/**
 * The pre-join screen shown when this browser tab has no stored session for
 * the room. Colours already claimed by existing members are fetched (no auth
 * needed) and greyed out; the authoritative uniqueness check still happens
 * server-side in `joinRoom`.
 */
function JoinGate({
  roomId,
  roomName,
  onJoined,
}: {
  roomId: string
  roomName: string
  onJoined: (session: RoomSession) => void
}) {
  const [name, setName] = React.useState("")
  const [selectedColor, setSelectedColor] = React.useState<string | null>(null)
  const [takenColors, setTakenColors] = React.useState<Set<string>>(new Set())
  const [error, setError] = React.useState<string | null>(null)
  const [isPending, startTransition] = React.useTransition()

  React.useEffect(() => {
    let active = true
    fetch(`/api/rooms/${roomId}/members`)
      .then((res) => (res.ok ? res.json() : []))
      .then((members: Array<{ color: string }>) => {
        if (active) setTakenColors(new Set(members.map((m) => m.color)))
      })
      .catch(() => {
        // Non-fatal: the join action re-checks uniqueness authoritatively.
      })
    return () => {
      active = false
    }
  }, [roomId])

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    if (!selectedColor) {
      setError("Pick a colour to continue.")
      return
    }
    startTransition(async () => {
      const result = await joinRoom(roomId, name, selectedColor)
      if (!result.ok) {
        setError(result.error)
        return
      }
      const session: RoomSession = {
        participantId: result.participantId,
        sessionToken: result.sessionToken,
        name: result.name,
        color: result.color,
      }
      setRoomSession(roomId, session)
      onJoined(session)
    })
  }

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-8 p-6">
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-xs tracking-widest text-muted-foreground uppercase">
          Joining
        </p>
        <h1 className="font-heading text-3xl font-medium tracking-tight">
          {roomName}
        </h1>
      </div>
      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-sm flex-col gap-4 border border-border bg-background p-6"
      >
        <div className="flex flex-col gap-2">
          <label
            htmlFor="join-name"
            className="text-xs font-medium text-muted-foreground"
          >
            Your name
          </label>
          <Input
            id="join-name"
            name="name"
            autoComplete="off"
            placeholder="Ada"
            maxLength={24}
            required
            disabled={isPending}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Pick your colour
          </span>
          <div className="grid grid-cols-6 gap-2">
            {PARTICIPANT_COLORS.map((c) => {
              const taken = takenColors.has(c.hex)
              const selected = selectedColor === c.hex
              return (
                <button
                  key={c.hex}
                  type="button"
                  disabled={taken || isPending}
                  aria-pressed={selected}
                  aria-label={taken ? `${c.name} (taken)` : c.name}
                  title={taken ? `${c.name} — taken` : c.name}
                  onClick={() => setSelectedColor(c.hex)}
                  className={cn(
                    "flex aspect-square items-center justify-center rounded-full ring-1 ring-foreground/10 transition disabled:cursor-not-allowed disabled:opacity-25",
                    selected &&
                      "ring-2 ring-foreground ring-offset-2 ring-offset-background"
                  )}
                  style={{ backgroundColor: c.hex }}
                >
                  {selected ? (
                    <CheckIcon className="size-3.5 text-white" weight="bold" />
                  ) : null}
                </button>
              )
            })}
          </div>
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <Button
          type="submit"
          disabled={isPending || name.trim().length === 0 || !selectedColor}
        >
          {isPending ? "Joining…" : "Join room"}
        </Button>
      </form>
    </main>
  )
}

/** Centered spinner while the Liveblocks room connection is establishing. */
function RoomLoading() {
  return (
    <div className="flex h-svh items-center justify-center bg-background">
      <SpinnerIcon className="size-6 animate-spin text-muted-foreground" />
    </div>
  )
}

/**
 * The connected room. Renders only inside RoomProvider so the presence hooks
 * are valid. Presence is ephemeral (ADR 0012); the colour change goes through
 * the `changeColor` server action (durable), then `updateMyPresence` reflects
 * it live and `onColorChange` persists it to this tab's sessionStorage.
 */
function RoomView({
  roomId,
  roomName,
  session,
  initialEventAt,
  onColorChange,
}: {
  roomId: string
  roomName: string
  session: RoomSession
  initialEventAt: string | null
  onColorChange: (color: string) => void
}) {
  const self = useSelf()
  const others = useOthers()
  const updateMyPresence = useUpdateMyPresence()

  // Figma-style live cursors on the header and chat panel (the map has its
  // own geo-anchored version — see room-map.tsx). Both hooks require a
  // RoomProvider ancestor, which RoomView is.
  const headerCursor = useSurfaceCursor("header")
  const chatCursor = useSurfaceCursor("chat")

  // Alt-tabbing away shouldn't leave a stale cursor parked on a surface.
  React.useEffect(() => {
    function handleBlur() {
      updateMyPresence({ cursor: null })
    }
    window.addEventListener("blur", handleBlur)
    return () => window.removeEventListener("blur", handleBlur)
  }, [updateMyPresence])

  const [colorOpen, setColorOpen] = React.useState(false)
  const [colorError, setColorError] = React.useState<string | null>(null)
  const [isChanging, startTransition] = React.useTransition()

  const myName = self?.info.name ?? session.name
  const myColor = self?.presence.color ?? session.color
  const othersColors = new Set(
    others.map((o) => o.presence.color ?? o.info.color)
  )
  const visibleOthers = others.slice(0, MAX_VISIBLE_OTHERS)
  const hiddenOthersCount = others.length - visibleOthers.length

  // Mobile (<md) chat sheet: hidden by default, toggled by the floating chat
  // button; desktop always shows the chat panel and never reads this state
  // (see the `md:` overrides below). `hasUnread` lights the button's dot when
  // a message arrives from someone else while the sheet is closed.
  const [chatOpen, setChatOpen] = React.useState(false)
  const [hasUnread, setHasUnread] = React.useState(false)
  function openChat() {
    setChatOpen(true)
    setHasUnread(false)
  }

  const handleCopyLink = React.useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      toast.error("Couldn't copy the link")
      return
    }
    navigator.clipboard
      .writeText(window.location.href)
      .then(() => toast.success("Link copied"))
      .catch(() => toast.error("Couldn't copy the link"))
  }, [])

  // Map state lives here (not in the map) so the map stays mounted across chat
  // interactions and Task 9 can feed the overlay without restructuring.
  const [origins, setOrigins] = React.useState<OriginPoint[]>([])
  // Overlay = agent-produced pins/routes/focus. Task 9 will additionally feed
  // this from analysis metadata; for now the chat results card drives it via
  // focusCandidate below (clicking a candidate flies the map to it).
  const [overlay, setOverlay] = React.useState<MapOverlay>({
    pins: [],
    routes: null,
    focus: null,
  })
  // The venue a place-preview card is currently open for (map pin click or
  // plan-card venue chip) — null when no card is showing. Cleared below
  // whenever `overlay.pins` no longer contains a pin with this id (a fresh
  // agent overlay replaced it, or the run was superseded).
  const [preview, setPreview] = React.useState<PlacePreviewTarget | null>(null)

  // Room-level target meeting time (London wall-clock string, or null). Seeded
  // from the server, kept live by the settings:update listener below and by the
  // chip's own optimistic echo. Feeds the header chip; the routing pipeline
  // reads the durable copy from rooms.settings.
  const [eventAt, setEventAt] = React.useState<string | null>(initialEventAt)

  // Whether THIS participant is the room's effective host — gates the "Lock it
  // in" control. Derived from the members API's isHost flag (see lib/host.ts).
  const [isHost, setIsHost] = React.useState(false)

  // Live agent state (Trigger.dev realtime): active/last run, status, streamed
  // text, map overlay, timeline, routing progress. Drives the map overlay, the
  // chat activity row, and the toasts below. Read-only — starting a run goes
  // through the askAgent server action.
  const agent = useRoomAgent(roomId, session.sessionToken)
  useAgentToasts({
    activeRun: agent.activeRun,
    lastRun: agent.lastRun,
    status: agent.status,
  })
  // The newest run's id once it has reached a final status — feeds usePlan to
  // trigger an authoritative plan refetch on completion.
  const completedRunId =
    agent.lastRun && isFinalStatus(agent.lastRun.status)
      ? agent.lastRun.id
      : undefined

  // Plan state is owned here (not in ChatPanel) so the chat panel and the
  // map-pane surfaces read one source. The hook fetches PlanResponse and folds
  // in plan:updated / vote:update / decided:update nudges (ADR 0014/0015).
  const planState = usePlan(
    roomId,
    session.sessionToken,
    completedRunId,
    session.participantId
  )
  // Why a re-plan is in flight. The `auto_constraints` source rides the run's
  // trigger-time metadata and is wired in a later phase; until then a re-plan is
  // always a manual re-run, so the label is the generic one.
  const updatingLabel =
    agent.activeRun?.metadata?.source === "auto_constraints"
      ? "Rethinking with your new preferences…"
      : "Updating the plan…"

  // Live replanning signal (G2-review carryover): a run is "replanning" the
  // instant an orchestrator run goes active, not only once the server flips the
  // newest snapshot to running/pending. This makes the "Updating…" badge, the
  // hearts-disable, and the Lock-it-in hide engage immediately. `agent.isActive`
  // is also true during a room's FIRST analysis (no plan yet), but the badge /
  // disable surfaces only render when a plan exists, so that case is inert.
  const replanningLive = planState.replanning || agent.isActive

  // Top-3 candidates of the current COMPLETE plan — the data behind the map-pane
  // venue carousel (a sibling of RoomMap). Empty (carousel hidden) until a
  // complete plan exists, so the first-run/failed/replanning-pre-first cases
  // render no carousel at all.
  const planCandidates = React.useMemo<PlanCandidate[]>(() => {
    const p = planState.data?.plan
    if (!p || p.status !== "complete") return []
    return [...(p.result?.candidates ?? [])]
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 3)
  }, [planState.data?.plan])
  const carouselVisible = planCandidates.length > 0

  // The carousel's focus cursor (which venue card is active) and collapse state.
  // `activeVenue` is set by the carousel's own scroll/arrows and by a venue-pin
  // or chat-chip click (handlePreviewChange / handleVenuePreview below).
  const [activeVenue, setActiveVenue] = React.useState<{
    h3: string
    index: number
  } | null>(null)
  const [carouselExpanded, setCarouselExpanded] = React.useState<boolean>(() => {
    if (typeof window === "undefined") return true
    const stored = window.sessionStorage.getItem(`rendezvous:carousel:${roomId}`)
    if (stored === "expanded") return true
    if (stored === "collapsed") return false
    // Default expanded on desktop; collapsed on a phone (never auto-cover a map).
    return window.matchMedia("(min-width: 768px)").matches
  })
  React.useEffect(() => {
    window.sessionStorage.setItem(
      `rendezvous:carousel:${roomId}`,
      carouselExpanded ? "expanded" : "collapsed"
    )
  }, [roomId, carouselExpanded])

  // Auto-expand (md+ only) when a NEW plan lands so a re-run resurfaces the
  // carousel; a phone keeps the pill (its own affordance) instead.
  const planAnalysisId = planState.data?.plan?.analysisId
  const prevAnalysisRef = React.useRef<string | undefined>(undefined)
  React.useEffect(() => {
    if (!planAnalysisId) return
    if (
      prevAnalysisRef.current !== undefined &&
      prevAnalysisRef.current !== planAnalysisId &&
      window.matchMedia("(min-width: 768px)").matches
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCarouselExpanded(true)
    }
    prevAnalysisRef.current = planAnalysisId
  }, [planAnalysisId])

  // Fold the agent's map overlay into the shared overlay state whenever it
  // changes (its identity is content-stable — see useRoomAgent). A manual
  // focusCandidate click can override it in between; the next agent update wins
  // again, which is correct (fresh results supersede a manual focus).
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (agent.overlay) setOverlay(agent.overlay)
  }, [agent.overlay])

  // Kick off an analysis from the header button. Disabled below while < 2
  // origins or a run is active; a needs_origins result still guards the race
  // where origins changed between render and click.
  const [isAsking, startAskTransition] = React.useTransition()
  const handleAskAgent = React.useCallback(() => {
    startAskTransition(async () => {
      try {
        const result = await askAgent(session.sessionToken, roomId)
        if (!result.ok) {
          toast.error("Set at least two start points on the map first.")
        }
      } catch (err) {
        console.error("askAgent failed", err)
        toast.error("Couldn't start the agent — please try again.")
      }
    })
  }, [session.sessionToken, roomId])

  // Toggle my approval vote on a candidate area. Broadcast-driven like reactions
  // (the vote:update echo updates usePlan — no optimistic local patch), so this
  // just fires the durable toggle against the DISPLAYED plan's snapshot. A stale
  // snapshot (a re-plan already superseded it) refetches the plan authoritatively.
  const handleToggleVote = React.useCallback(
    (candidateH3: string) => {
      const snapshotId = planState.data?.plan?.id
      if (!snapshotId) return
      React.startTransition(async () => {
        try {
          const res = await toggleVote(
            session.sessionToken,
            roomId,
            snapshotId,
            candidateH3
          )
          if (!res.ok && res.error === "stale_snapshot") planState.refetch()
        } catch (err) {
          console.error("toggleVote failed", err)
        }
      })
    },
    [session.sessionToken, roomId, planState]
  )

  // Host-only: lock in a candidate as the decision. decided:update patches every
  // tab (incl. this one) via usePlan; failures surface as a toast.
  const handleDecide = React.useCallback(
    (candidateH3: string) => {
      const snapshotId = planState.data?.plan?.id
      if (!snapshotId) return
      React.startTransition(async () => {
        try {
          const res = await decidePlan(
            session.sessionToken,
            roomId,
            snapshotId,
            candidateH3
          )
          if (!res.ok) {
            if (res.error === "stale_snapshot") planState.refetch()
            else if (res.error === "not_host")
              toast.error("Only the host can lock in a spot.")
            else if (res.error === "already_decided")
              toast.error("A spot is already locked in.")
            else if (res.error === "replanning")
              toast.error("The plan is updating — try again in a moment.")
            else toast.error("Couldn't lock it in — please try again.")
          }
        } catch (err) {
          console.error("decidePlan failed", err)
          toast.error("Couldn't lock it in — please try again.")
        }
      })
    },
    [session.sessionToken, roomId, planState]
  )

  // Paint a chosen plan candidate onto the map and fly to it: a pin for the
  // area (its H3 cell centre) plus a pin per venue, and — the G3 addition — one
  // route line per participant built from their real TfL leg geometry
  // (`journey.legs[].pathPoints`), coloured like the origin. pathPoints are
  // [lat, lon] but GeoJSON wants [lng, lat], so they're flipped here (skip it
  // and the routes land in the sea). A participant with no leg geometry falls
  // back to a straight origin→centre line. `venueIndex` (from the carousel)
  // flies to a specific venue at a tighter zoom instead of the area centre.
  // Called from the chat results card and the carousel; guards a malformed H3
  // by falling back to the venue centroid, no-ops if neither yields a centre.
  const focusCandidate = React.useCallback(
    (candidate: PlanCandidate, venueIndex?: number) => {
      const venuePins = candidateVenuePins(candidate)
      const venuePoints = venuePins.map((p) => p.venue)

      let center: { lat: number; lng: number } | null = null
      try {
        // candidate.h3 is a DECIMAL string (ADR 0008); h3-js speaks hex. Passing
        // the decimal straight to cellToLatLng parses it as hex and flies the
        // map to the wrong place (mid-Atlantic). Convert first, then validate.
        const hex = BigInt(candidate.h3).toString(16)
        if (isValidCell(hex)) {
          const [lat, lng] = cellToLatLng(hex)
          if (Number.isFinite(lat) && Number.isFinite(lng)) center = { lat, lng }
        }
      } catch {
        // Malformed H3 cell (non-numeric string) — fall through to the venue
        // centroid.
      }
      if (!center && venuePoints.length > 0) {
        const sum = venuePoints.reduce(
          (acc, v) => ({ lat: acc.lat + v.lat, lng: acc.lng + v.lng }),
          { lat: 0, lng: 0 }
        )
        center = {
          lat: sum.lat / venuePoints.length,
          lng: sum.lng / venuePoints.length,
        }
      }
      if (!center) return
      const areaCenter = center

      const pins: MapOverlay["pins"] = [
        {
          id: `candidate-${candidate.h3}`,
          lat: areaCenter.lat,
          lng: areaCenter.lng,
          kind: "candidate",
          rank: candidate.rank,
          label: candidate.name,
        },
        ...venuePins.map(({ venue, id }) => ({
          id,
          lat: venue.lat,
          lng: venue.lng,
          kind: "venue" as const,
          label: venue.name,
          ...(venue.fsqPlaceId ? { placeId: venue.fsqPlaceId } : {}),
          ...(venue.googlePlaceId ? { googlePlaceId: venue.googlePlaceId } : {}),
        })),
      ]

      // Per-participant route geometry from real journeys, straight-line
      // fallback when a participant has no captured leg geometry.
      const features: GeoJSON.Feature[] = []
      for (const p of candidate.perParticipant) {
        const geomLegs = (p.journey?.legs ?? []).filter(
          (l) => l.pathPoints && l.pathPoints.length >= 2
        )
        if (geomLegs.length > 0) {
          for (const l of geomLegs) {
            features.push({
              type: "Feature",
              geometry: {
                type: "LineString",
                coordinates: l.pathPoints!.map(([lat, lon]) => [lon, lat]),
              },
              properties: { color: p.color, mode: l.mode },
            })
          }
        } else {
          const origin = origins.find(
            (o) => o.participantId === p.participantId
          )
          if (origin) {
            features.push({
              type: "Feature",
              geometry: {
                type: "LineString",
                coordinates: [
                  [origin.lng, origin.lat],
                  [areaCenter.lng, areaCenter.lat],
                ],
              },
              properties: { color: p.color },
            })
          }
        }
      }
      const routes: GeoJSON.FeatureCollection | null = features.length
        ? { type: "FeatureCollection", features }
        : null

      const targetVenue =
        venueIndex !== undefined ? venuePins[venueIndex]?.venue : undefined
      const focus = targetVenue
        ? { lat: targetVenue.lat, lng: targetVenue.lng, zoom: 15 }
        : { ...areaCenter, zoom: 14 }

      setOverlay({ pins, routes, focus })
    },
    [origins]
  )

  // Open a place-preview card for one venue on a candidate: focuses the map
  // on that candidate (as a row click would) and opens the card at the pin
  // `focusCandidate` just placed for it — reusing `candidateVenuePins` so the
  // id always matches, which keeps the clear-on-overlay-change effect below
  // from immediately closing a card that was just opened.
  const handleVenuePreview = React.useCallback(
    (candidate: PlanCandidate, venueIndex: number) => {
      // Close the mobile chat sheet so the focused map is actually visible —
      // otherwise the full-height sheet covers the map and the tap looks like it
      // did nothing. No-op on md+ (the aside's `md:` overrides keep it static).
      setChatOpen(false)
      const venue = candidate.venues[venueIndex]
      if (!venue) return
      const pins = candidateVenuePins(candidate)
      const filteredIndex = pins.findIndex((p) => p.venue === venue)
      // When the carousel is up, a chip activates its card (the card IS the rich
      // preview) instead of opening a popup that would sit over the carousel.
      if (
        carouselVisible &&
        carouselExpanded &&
        filteredIndex >= 0 &&
        planCandidates.some((c) => c.h3 === candidate.h3)
      ) {
        setActiveVenue({ h3: candidate.h3, index: filteredIndex })
        return
      }
      focusCandidate(candidate)
      const pin = filteredIndex >= 0 ? pins[filteredIndex] : undefined
      if (!pin) return // non-finite coordinates — no pin was placed for it
      setPreview({
        id: pin.id,
        name: venue.name,
        lat: venue.lat,
        lng: venue.lng,
        category: venue.category,
        fsqPlaceId: venue.fsqPlaceId,
        googlePlaceId: venue.googlePlaceId,
      })
    },
    [focusCandidate, carouselVisible, carouselExpanded, planCandidates]
  )

  // A fresh agent overlay (or a focusCandidate call for a different
  // candidate) can drop the pin the open preview points at — close the card
  // rather than leave it pinned to a stale/vanished location.
  React.useEffect(() => {
    if (!preview) return
    // Match by id AND coordinates. `venue-<h3>-<i>` ids recur across plans for
    // the same winning cell, so a fresh overlay can carry a pin with this exact
    // id that now points at a DIFFERENT venue — an id-only check would leave the
    // card pinned to a stale location/venue. Require the pin's lat/lng to still
    // match the preview's (small epsilon absorbs float round-tripping).
    const EPS = 1e-6
    const stillValid = overlay.pins.some(
      (p) =>
        p.id === preview.id &&
        Math.abs(p.lat - preview.lat) < EPS &&
        Math.abs(p.lng - preview.lng) < EPS
    )
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!stillValid) setPreview(null)
  }, [overlay.pins, preview])

  // participantId → {name, color}, used to enrich origin:update nudges (which
  // carry only coordinates) without a round-trip. Refetched if an unknown
  // participant appears (e.g. someone who joined after this map loaded).
  const membersRef = React.useRef<Map<string, { name: string; color: string }>>(
    new Map()
  )

  const loadMembers = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/rooms/${roomId}/members`)
      if (!res.ok) return
      const members: Array<{
        participantId: string
        name: string
        color: string
        isHost?: boolean
      }> = await res.json()
      membersRef.current = new Map(
        members.map((m) => [m.participantId, { name: m.name, color: m.color }])
      )
      const mine = members.find(
        (m) => m.participantId === session.participantId
      )
      // setState after the awaited fetch, not synchronously in an effect body.
      setIsHost(!!mine?.isHost)
    } catch {
      // Non-fatal: enrichment falls back to a full origins refetch.
    }
  }, [roomId, session.participantId])

  const loadOrigins = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/rooms/${roomId}/origins`, {
        headers: { Authorization: `Bearer ${session.sessionToken}` },
      })
      if (!res.ok) return
      const data: OriginPoint[] = await res.json()
      setOrigins(data)
    } catch {
      // Non-fatal: the map shows no origins until the next nudge lands.
    }
  }, [roomId, session.sessionToken])

  React.useEffect(() => {
    // Fetch-on-mount: loadMembers (setIsHost) and loadOrigins (setOrigins) both
    // setState only after their awaited fetch resolves, not synchronously in the
    // effect body, so they don't cascade renders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadMembers()
    void loadOrigins()
  }, [loadMembers, loadOrigins])

  // origin:update is a nudge (ADR 0012): apply the payload with name/colour
  // from the members map, or refetch authoritatively if the member is unknown.
  // member:update surfaces a small info toast (skipping my own colour echo).
  useEventListener(({ event }) => {
    if (event.type === "member:update") {
      if (event.participantId === session.participantId) return
      // Keep the members cache and any existing origin pin in sync with the
      // new name/colour — a colour change must recolour the pin on the map,
      // not merely raise a toast (origin pins carry the durable colour, which
      // this event is the live refresh for).
      membersRef.current.set(event.participantId, {
        name: event.name,
        color: event.color,
      })
      setOrigins((prev) =>
        prev.map((o) =>
          o.participantId === event.participantId
            ? { ...o, name: event.name, color: event.color }
            : o
        )
      )
      toast.info(
        event.kind === "joined"
          ? `${event.name} joined`
          : `${event.name} changed colour`
      )
      return
    }
    if (event.type === "message:new") {
      // Mobile-only signal: the sheet is always open on desktop, so this is a
      // no-op there.
      if (!chatOpen && event.message.participantId !== session.participantId) {
        setHasUnread(true)
      }
      return
    }
    if (event.type === "settings:update") {
      // Full-payload nudge (ADR 0014): the event time changed in another tab.
      setEventAt(event.eventAt)
      return
    }
    if (event.type !== "origin:update") return
    const member = membersRef.current.get(event.participantId)
    if (!member) {
      void loadMembers()
      void loadOrigins()
      return
    }
    const next: OriginPoint = {
      participantId: event.participantId,
      name: member.name,
      color: member.color,
      lat: event.lat,
      lng: event.lng,
      ...(event.label ? { label: event.label } : {}),
    }
    setOrigins((prev) => [
      ...prev.filter((o) => o.participantId !== next.participantId),
      next,
    ])
  })

  // The carousel reports its active card here: track the cursor, close any open
  // popup, and focus the candidate (draws its real routes + flies the camera).
  const handleActiveVenue = React.useCallback(
    (candidate: PlanCandidate, venueIndex: number) => {
      setActiveVenue({ h3: candidate.h3, index: venueIndex })
      setPreview(null)
      focusCandidate(candidate, venueIndex)
    },
    [focusCandidate]
  )

  // Voter dot colours, resolved from the members cache (near-static — a colour
  // change is rare and re-renders via member:update anyway).
  const getMemberColor = React.useCallback(
    (participantId: string) => membersRef.current.get(participantId)?.color,
    []
  )

  // Venue-pin clicks: when the carousel is expanded, route a top-3 venue pin to
  // the matching card (no popup — it would double up over the carousel).
  // Everything else keeps the existing preview-popup behaviour.
  const handlePreviewChange = React.useCallback(
    (target: PlacePreviewTarget | null) => {
      if (target && carouselVisible && carouselExpanded) {
        const m = /^venue-(\d+)-(\d+)$/.exec(target.id)
        if (m) {
          const h3 = m[1]!
          const index = Number(m[2])
          if (index < 5 && planCandidates.some((c) => c.h3 === h3)) {
            setActiveVenue({ h3, index })
            return
          }
        }
      }
      setPreview(target)
    },
    [carouselVisible, carouselExpanded, planCandidates]
  )

  // Lift the map's set-origin cluster above the carousel while it's expanded.
  const controlsRaised = carouselVisible && carouselExpanded

  function handleColorChange(hex: string) {
    if (hex === myColor) {
      setColorOpen(false)
      return
    }
    setColorError(null)
    startTransition(async () => {
      const result = await changeColor(session.sessionToken, roomId, hex)
      if (!result.ok) {
        setColorError(result.error)
        return
      }
      updateMyPresence({ color: result.color })
      onColorChange(result.color)
      setColorOpen(false)
    })
  }

  return (
    <div className="flex h-svh flex-col bg-background">
      <header
        className="relative flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4"
        onPointerMove={headerCursor.onPointerMove}
        onPointerLeave={headerCursor.onPointerLeave}
      >
        <div className="flex min-w-0 items-center gap-2">
          <MapPinIcon
            className="size-4 shrink-0 text-muted-foreground"
            weight="fill"
          />
          <h1
            className="truncate font-heading text-lg font-medium tracking-tight"
            title={roomName}
          >
            {roomName}
          </h1>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Copy room link"
            onClick={handleCopyLink}
            className="shrink-0 text-muted-foreground"
          >
            <LinkIcon />
          </Button>
          <EventTimeChip
            roomId={roomId}
            sessionToken={session.sessionToken}
            eventAt={eventAt}
            onChanged={setEventAt}
          />
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <AvatarGroup>
            <DropdownMenu open={colorOpen} onOpenChange={setColorOpen}>
              <DropdownMenuTrigger
                aria-label="Change your colour"
                className="relative rounded-full ring-2 ring-background outline-none focus-visible:ring-ring"
              >
                <InitialAvatar name={myName} color={myColor} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-auto min-w-0 p-2">
                <DropdownMenuLabel className="px-1 pt-0 pb-1.5">
                  Your colour
                </DropdownMenuLabel>
                <div className="grid grid-cols-6 gap-1.5">
                  {PARTICIPANT_COLORS.map((c) => {
                    const takenByOther =
                      c.hex !== myColor && othersColors.has(c.hex)
                    const selected = c.hex === myColor
                    return (
                      <button
                        key={c.hex}
                        type="button"
                        disabled={takenByOther || isChanging}
                        aria-pressed={selected}
                        aria-label={takenByOther ? `${c.name} (taken)` : c.name}
                        title={takenByOther ? `${c.name} — taken` : c.name}
                        onClick={() => handleColorChange(c.hex)}
                        className={cn(
                          "flex size-6 items-center justify-center rounded-full ring-1 ring-foreground/10 transition disabled:cursor-not-allowed disabled:opacity-25",
                          selected && "ring-2 ring-foreground"
                        )}
                        style={{ backgroundColor: c.hex }}
                      >
                        {selected ? (
                          <CheckIcon
                            className="size-3 text-white"
                            weight="bold"
                          />
                        ) : null}
                      </button>
                    )
                  })}
                </div>
                {colorError ? (
                  <p className="px-1 pt-2 text-xs text-destructive">
                    {colorError}
                  </p>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>

            {visibleOthers.map((other) => (
              <InitialAvatar
                key={other.connectionId}
                name={other.info.name}
                color={other.presence.color ?? other.info.color}
                title={other.info.name}
              />
            ))}

            {hiddenOthersCount > 0 ? (
              <AvatarGroupCount title={`${hiddenOthersCount} more`}>
                +{hiddenOthersCount}
              </AvatarGroupCount>
            ) : null}
          </AvatarGroup>

          {(() => {
            const disabledReason = agent.isActive
              ? "The agent is already working…"
              : origins.length < 2
                ? "Set at least two start points on the map first"
                : null
            const disabled = disabledReason !== null || isAsking
            return (
              // Wrapper span carries the native tooltip: a disabled button
              // doesn't emit hover events, so `pointer-events-none` lets the
              // hover fall through to the span's `title`.
              <span title={disabledReason ?? undefined} className="inline-flex">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={handleAskAgent}
                  className={cn(disabled && "pointer-events-none")}
                >
                  <SparkleIcon />
                  Find fair spots
                </Button>
              </span>
            )
          })()}
        </div>
        <CursorOverlay surface="header" />
      </header>

      <main className="flex min-h-0 flex-1">
        <div id="map-pane" className="relative h-full flex-1">
          <RoomMap
            roomId={roomId}
            session={{
              participantId: session.participantId,
              sessionToken: session.sessionToken,
              color: myColor,
            }}
            origins={origins}
            overlay={overlay}
            preview={preview}
            onPreviewChange={handlePreviewChange}
            controlsRaised={controlsRaised}
          />
          {carouselVisible ? (
            <VenueCarousel
              candidates={planCandidates}
              votes={planState.data?.votes ?? []}
              myVotes={planState.data?.myVotes ?? []}
              decision={planState.data?.decision ?? null}
              eventAt={eventAt}
              replanning={replanningLive}
              isHost={isHost}
              myColor={myColor}
              roomId={roomId}
              sessionToken={session.sessionToken}
              getMemberColor={getMemberColor}
              activeVenue={activeVenue}
              onActiveVenue={handleActiveVenue}
              onToggleVote={handleToggleVote}
              onDecide={handleDecide}
              expanded={carouselExpanded}
              onExpandedChange={setCarouselExpanded}
            />
          ) : null}
        </div>
        {/* Mobile (<md): a full-height sheet toggled by the floating chat
            button below, sliding up over the map. Desktop (md+): the usual
            static 380px side panel — the `md:` overrides win regardless of
            `chatOpen`. */}
        <aside
          className={cn(
            "fixed inset-x-0 top-14 bottom-0 z-30 flex flex-col border-t border-border bg-background transition-transform duration-200 ease-out",
            chatOpen ? "translate-y-0" : "pointer-events-none translate-y-full",
            // `md:relative` (not `md:static`): CursorOverlay below is
            // absolutely positioned and needs this as its containing block on
            // desktop, or it'd resolve against the viewport instead.
            "md:pointer-events-auto md:relative md:inset-auto md:z-auto md:h-full md:w-[380px] md:shrink-0 md:translate-y-0 md:border-t-0 md:border-l"
          )}
          onPointerMove={chatCursor.onPointerMove}
          onPointerLeave={chatCursor.onPointerLeave}
        >
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4 text-muted-foreground">
            <ChatCircleDotsIcon className="size-4" />
            <span className="text-xs font-medium">Chat</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Close chat"
              onClick={() => setChatOpen(false)}
              className="ml-auto md:hidden"
            >
              <XIcon />
            </Button>
          </div>
          <ChatPanel
            roomId={roomId}
            session={session}
            agent={{
              status: agent.status,
              streamText: agent.streamText,
              progress: agent.progress,
              timeline: agent.timeline,
              isActive: agent.isActive,
            }}
            plan={planState.data?.plan ?? null}
            eventAt={eventAt}
            replanning={replanningLive}
            updateFailed={planState.updateFailed}
            updatingLabel={updatingLabel}
            votes={planState.data?.votes ?? []}
            myVotes={planState.data?.myVotes ?? []}
            decision={planState.data?.decision ?? null}
            myColor={myColor}
            isHost={isHost}
            onFocusCandidate={focusCandidate}
            onVenuePreview={handleVenuePreview}
            onToggleVote={handleToggleVote}
            onDecide={handleDecide}
          />
          <CursorOverlay surface="chat" />
        </aside>

        {!chatOpen ? (
          <div className="fixed right-4 bottom-4 z-40 md:hidden">
            <Button
              type="button"
              size="icon-lg"
              aria-label={hasUnread ? "Open chat — new messages" : "Open chat"}
              onClick={openChat}
              className="shadow-md"
            >
              <ChatCircleDotsIcon weight="fill" />
            </Button>
            {hasUnread ? (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-0.5 right-0.5 size-2.5 rounded-full bg-destructive ring-2 ring-background"
              />
            ) : null}
          </div>
        ) : null}
      </main>

      <Toaster position="bottom-left" />
    </div>
  )
}

// Stable-identity snapshot so useSyncExternalStore doesn't loop: only hand back
// a fresh object when the stored value actually changed.
const sessionSnapshots = new Map<
  string,
  { serialized: string; value: RoomSession | null }
>()

function readStableRoomSession(roomId: string): RoomSession | null {
  const value = getRoomSession(roomId)
  const serialized = JSON.stringify(value)
  const cached = sessionSnapshots.get(roomId)
  if (cached && cached.serialized === serialized) return cached.value
  sessionSnapshots.set(roomId, { serialized, value })
  return value
}

function subscribeToSessionStorage(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  // Only cross-tab writes fire `storage`; same-tab join/colour updates are
  // applied through local state below instead.
  window.addEventListener("storage", onChange)
  return () => window.removeEventListener("storage", onChange)
}

/**
 * Room entry point. This tab's session lives in sessionStorage (client-only),
 * so it's read via useSyncExternalStore with a null server snapshot — that
 * keeps SSR and hydration consistent without a mismatch, and React swaps in
 * the client value before paint. No session → the join gate; otherwise wire up
 * the Liveblocks providers and drop into the connected room.
 */
export function RoomShell({
  roomId,
  roomName,
  initialEventAt,
}: {
  roomId: string
  roomName: string
  initialEventAt: string | null
}) {
  const storedSession = React.useSyncExternalStore(
    subscribeToSessionStorage,
    () => readStableRoomSession(roomId),
    () => null
  )
  // Same-tab join / colour changes take effect immediately (sessionStorage's
  // `storage` event is cross-tab only), overriding the stored snapshot.
  const [localSession, setLocalSession] = React.useState<RoomSession | null>(
    null
  )
  // Set when a Liveblocks auth attempt returns 401 — a stale sessionStorage
  // token (e.g. after a DB reset). Forces the join gate to re-render instead
  // of spinning forever on doomed auth retries; cleared again on a fresh join.
  const [authRejected, setAuthRejected] = React.useState(false)
  const session = authRejected ? null : (localSession ?? storedSession)

  const handleJoined = React.useCallback((next: RoomSession) => {
    setAuthRejected(false)
    setLocalSession(next)
  }, [])

  if (!session) {
    return (
      <JoinGate roomId={roomId} roomName={roomName} onJoined={handleJoined} />
    )
  }

  const activeSession = session

  function handleColorChange(color: string) {
    const next: RoomSession = { ...activeSession, color }
    setRoomSession(roomId, next)
    setLocalSession(next)
  }

  return (
    <LiveblocksProvider
      throttle={16}
      authEndpoint={async (room) => {
        const res = await fetch("/api/liveblocks-auth", {
          method: "POST",
          body: JSON.stringify({
            room,
            sessionToken: activeSession.sessionToken,
          }),
        })
        if (!res.ok) {
          // A stale sessionStorage token (e.g. after a DB reset) 401s here.
          // Clear it and drop back to the join gate rather than letting
          // Liveblocks retry a doomed auth forever behind the spinner.
          if (res.status === 401) {
            clearRoomSession(roomId)
            setAuthRejected(true)
          }
          throw new Error(`Liveblocks auth failed: ${res.status}`)
        }
        return res.json()
      }}
    >
      <RoomProvider
        id={`room:${roomId}`}
        initialPresence={{
          cursor: null,
          isTyping: false,
          color: activeSession.color,
        }}
      >
        <ClientSideSuspense fallback={<RoomLoading />}>
          <RoomView
            roomId={roomId}
            roomName={roomName}
            session={activeSession}
            initialEventAt={initialEventAt}
            onColorChange={handleColorChange}
          />
        </ClientSideSuspense>
      </RoomProvider>
    </LiveblocksProvider>
  )
}
