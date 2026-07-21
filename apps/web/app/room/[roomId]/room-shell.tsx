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
import { MapPinIcon } from "@phosphor-icons/react/dist/csr/MapPin"
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle"
import { SpinnerIcon } from "@phosphor-icons/react/dist/csr/Spinner"

import { Avatar, AvatarFallback, AvatarGroup } from "@workspace/ui/components/avatar"
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

import { cellToLatLng } from "h3-js"

import { askAgent } from "@/app/actions/agent"
import { changeColor, joinRoom } from "@/app/actions/room"
import { ChatPanel } from "@/components/chat/chat-panel"
import { useAgentToasts } from "@/hooks/use-agent-toasts"
import { isFinalStatus, useRoomAgent } from "@/hooks/use-room-agent"
import { PARTICIPANT_COLORS } from "@/lib/colors"
import {
  getRoomSession,
  setRoomSession,
  type RoomSession,
} from "@/lib/session"
import type { MapOverlay, OriginPoint, PlanCandidate } from "@/lib/types"

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
  onColorChange,
}: {
  roomId: string
  roomName: string
  session: RoomSession
  onColorChange: (color: string) => void
}) {
  const self = useSelf()
  const others = useOthers()
  const updateMyPresence = useUpdateMyPresence()

  const [colorOpen, setColorOpen] = React.useState(false)
  const [colorError, setColorError] = React.useState<string | null>(null)
  const [isChanging, startTransition] = React.useTransition()

  const myName = self?.info.name ?? session.name
  const myColor = self?.presence.color ?? session.color
  const othersColors = new Set(
    others.map((o) => o.presence.color ?? o.info.color)
  )

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
  // The newest run's id once it has reached a final status — handed to the chat
  // panel to trigger an authoritative plan refetch on completion.
  const completedRunId =
    agent.lastRun && isFinalStatus(agent.lastRun.status)
      ? agent.lastRun.id
      : undefined

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

  // Paint a chosen plan candidate onto the map and fly to it: a pin for the
  // area (its H3 cell centre) plus a pin per venue. Called from the chat
  // results card. Guards against a malformed H3 by falling back to the venue
  // centroid, and no-ops if neither yields a usable centre.
  const focusCandidate = React.useCallback((candidate: PlanCandidate) => {
    const venuePoints = candidate.venues.filter(
      (v) => Number.isFinite(v.lat) && Number.isFinite(v.lng)
    )

    let center: { lat: number; lng: number } | null = null
    try {
      const [lat, lng] = cellToLatLng(candidate.h3)
      if (Number.isFinite(lat) && Number.isFinite(lng)) center = { lat, lng }
    } catch {
      // Malformed H3 cell — fall through to the venue centroid.
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

    const pins: MapOverlay["pins"] = [
      {
        id: `candidate-${candidate.h3}`,
        lat: center.lat,
        lng: center.lng,
        kind: "candidate",
        rank: candidate.rank,
        label: candidate.name,
      },
      ...venuePoints.map((v, i) => ({
        id: `venue-${candidate.h3}-${i}`,
        lat: v.lat,
        lng: v.lng,
        kind: "venue" as const,
        label: v.name,
      })),
    ]
    setOverlay({ pins, routes: null, focus: { ...center, zoom: 14 } })
  }, [])

  // participantId → {name, color}, used to enrich origin:update nudges (which
  // carry only coordinates) without a round-trip. Refetched if an unknown
  // participant appears (e.g. someone who joined after this map loaded).
  const membersRef = React.useRef<
    Map<string, { name: string; color: string }>
  >(new Map())

  const loadMembers = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/rooms/${roomId}/members`)
      if (!res.ok) return
      const members: Array<{
        participantId: string
        name: string
        color: string
      }> = await res.json()
      membersRef.current = new Map(
        members.map((m) => [m.participantId, { name: m.name, color: m.color }])
      )
    } catch {
      // Non-fatal: enrichment falls back to a full origins refetch.
    }
  }, [roomId])

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
    void loadMembers()
    // Fetch-on-mount: setOrigins runs asynchronously after the await, not
    // synchronously in the effect body, so it doesn't cascade renders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadOrigins()
  }, [loadMembers, loadOrigins])

  // origin:update is a nudge (ADR 0012): apply the payload with name/colour
  // from the members map, or refetch authoritatively if the member is unknown.
  // member:update surfaces a small info toast (skipping my own colour echo).
  useEventListener(({ event }) => {
    if (event.type === "member:update") {
      if (event.participantId === session.participantId) return
      toast.info(
        event.kind === "joined"
          ? `${event.name} joined`
          : `${event.name} changed colour`
      )
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
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
          <MapPinIcon
            className="size-4 text-muted-foreground"
            weight="fill"
          />
          <h1 className="font-heading text-lg font-medium tracking-tight">
            {roomName}
          </h1>
        </div>

        <div className="flex items-center gap-3">
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
                        aria-label={
                          takenByOther ? `${c.name} (taken)` : c.name
                        }
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

            {others.map((other) => (
              <InitialAvatar
                key={other.connectionId}
                name={other.info.name}
                color={other.presence.color ?? other.info.color}
                title={other.info.name}
              />
            ))}
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
              <span
                title={disabledReason ?? undefined}
                className="inline-flex"
              >
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
          />
        </div>
        <aside className="flex h-full w-[380px] shrink-0 flex-col border-l border-border">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4 text-muted-foreground">
            <ChatCircleDotsIcon className="size-4" />
            <span className="text-xs font-medium">Chat</span>
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
            completedRunId={completedRunId}
            onFocusCandidate={focusCandidate}
          />
        </aside>
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
}: {
  roomId: string
  roomName: string
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
  const session = localSession ?? storedSession

  if (!session) {
    return (
      <JoinGate
        roomId={roomId}
        roomName={roomName}
        onJoined={setLocalSession}
      />
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
      throttle={100}
      authEndpoint={async (room) => {
        const res = await fetch("/api/liveblocks-auth", {
          method: "POST",
          body: JSON.stringify({
            room,
            sessionToken: activeSession.sessionToken,
          }),
        })
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
            onColorChange={handleColorChange}
          />
        </ClientSideSuspense>
      </RoomProvider>
    </LiveblocksProvider>
  )
}
