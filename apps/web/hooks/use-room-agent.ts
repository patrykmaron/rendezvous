"use client"

import * as React from "react"

import {
  useRealtimeRunsWithTag,
  useRealtimeStream,
} from "@trigger.dev/react-hooks"

// TYPE-only, from the dependency-light types module (not the task impl) — gives
// the realtime hooks their run typing without dragging the task graph (and its
// conflicting global Liveblocks augmentation) into web. See room-agent.types.ts.
import type { RoomAgentTask } from "@workspace/tasks/trigger/room-agent.types"

import type { MapOverlay } from "@/lib/types"

// The realtime stream key the room-agent task appends assistant-token deltas to
// (packages/tasks/src/trigger/streams.ts: `streams.define({ id: "agent" })`).
// We subscribe by this id STRING rather than value-importing `agentStream`:
// that definition pulls in `@trigger.dev/sdk`, which requires `node:async_hooks`
// and so cannot be bundled into a client component. The string-key overload of
// useRealtimeStream reads the exact same stream — with no SDK import.
const AGENT_STREAM_ID = "agent"

// A run's lifecycle status, per @trigger.dev/core's RunStatus enum. These are
// the states from which a run will never progress further — anything else
// (QUEUED, EXECUTING, WAITING, …) means the agent is still working.
const FINAL_STATUSES = new Set([
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
])

export function isFinalStatus(status: string): boolean {
  return FINAL_STATUSES.has(status)
}

// The agent surfaces {phase,label} on metadata.status (see room-agent's
// setStatus). Structural mirror — the task is a package, not shared code.
export type AgentStatus = { phase: string; label: string }
export type AgentTimelineEntry = { at: string; label: string }
export type AgentProgress = { routesDone?: number; routesTotal?: number }

export function asStatus(value: unknown): AgentStatus | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>
    if (typeof o.phase === "string" && typeof o.label === "string") {
      return { phase: o.phase, label: o.label }
    }
  }
  return undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}

// The refresh cadence for the realtime token. The server mints it with a ~1h
// expiry; refetching well inside that window keeps a long-lived room alive.
const TOKEN_REFRESH_MS = 50 * 60 * 1000

// The subset of agent state the chat panel needs to render live activity.
export type ChatAgentActivity = {
  status: AgentStatus | undefined
  streamText: string
  progress: AgentProgress
  timeline: AgentTimelineEntry[] | undefined
  isActive: boolean
}

export type RoomAgentState = {
  /** The Trigger.dev public token, or null while unavailable (no key / 401). */
  token: string | null
  /** Latest run still in flight (non-final status), if any. */
  activeRun: ReturnType<typeof useRealtimeRunsWithTag>["runs"][number] | undefined
  /** Most recent run overall, regardless of status. */
  lastRun: ReturnType<typeof useRealtimeRunsWithTag>["runs"][number] | undefined
  /** The active run's {phase,label}, undefined when nothing is running. */
  status: AgentStatus | undefined
  /** Agent-painted overlay from the active OR last run — persists after done. */
  overlay: MapOverlay | null
  /** Cumulative status timeline for the active/last run. */
  timeline: AgentTimelineEntry[] | undefined
  /** Routing progress (routesDone/routesTotal), populated during routing. */
  progress: AgentProgress
  /** Live token stream text for the active run ("" when none). */
  streamText: string
  /** Whether a run is currently in flight. */
  isActive: boolean
}

/**
 * Subscribes the web room to its Trigger.dev room-agent runs + token stream.
 *
 * Fetches a room-scoped realtime token (cached in memory, refetched on error /
 * every ~50min), then uses it to subscribe to every `room:<id>`-tagged run and
 * to the active run's `agent` token stream. The `room:<id>` tag is shared with
 * the always-listening extract-constraints runs (see agent-trigger.ts), so all
 * derivations below run against `agentRuns` — the subscription filtered down to
 * the `room-agent` orchestrator by task id — never the raw tag feed. Derives
 * the active/last run, the live status, the map overlay, the timeline, routing
 * progress, and the streamed assistant text — everything the shell needs to
 * render agent activity. Read-only: triggering happens through the `askAgent`
 * action.
 */
export function useRoomAgent(
  roomId: string,
  sessionToken: string
): RoomAgentState {
  const [token, setToken] = React.useState<string | null>(null)
  const fetchingRef = React.useRef(false)

  const fetchToken = React.useCallback(async () => {
    if (fetchingRef.current) return
    fetchingRef.current = true
    try {
      const res = await fetch(`/api/rooms/${roomId}/realtime-token`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      })
      if (!res.ok) {
        // 401 (not a member) or 500 (no server secret key) — no realtime.
        setToken(null)
        return
      }
      const data = (await res.json()) as { token: string }
      setToken(data.token)
    } catch {
      setToken(null)
    } finally {
      fetchingRef.current = false
    }
  }, [roomId, sessionToken])

  React.useEffect(() => {
    // fetchToken setState()s only after its awaited fetch resolves, not
    // synchronously in the effect body, so it doesn't cascade renders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchToken()
    const interval = setInterval(() => void fetchToken(), TOKEN_REFRESH_MS)
    return () => clearInterval(interval)
  }, [fetchToken])

  const { runs, error: runsError } = useRealtimeRunsWithTag<RoomAgentTask>(
    `room:${roomId}`,
    {
      accessToken: token ?? undefined,
      enabled: !!token,
      // Skip the (large, unused) payload column from the subscription — we read
      // everything the UI needs from run.metadata + status.
      skipColumns: ["payload"],
    }
  )

  // A subscription error while we hold a token usually means the token expired
  // — refetch once per distinct error message (guarded against a refetch loop).
  const lastHandledError = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!runsError || !token) return
    if (lastHandledError.current === runsError.message) return
    lastHandledError.current = runsError.message
    void fetchToken()
  }, [runsError, token, fetchToken])

  // The `room:<id>` tag is shared: queueConstraintExtraction tags every
  // extract-constraints run `room:<id>` as well (harmless — useful in the
  // Trigger dashboard). Filter the subscription to the orchestrator by task id
  // BEFORE any downstream selection, so an extraction run can never become the
  // activeRun/lastRun and thus never drives a false "Agent is working…" toast,
  // a spurious plan refetch, an overlay/status read, or a stuck-QUEUED loading
  // toast when the worker is down. `taskIdentifier` is the RunShape field (see
  // @trigger.dev/core runStream.d.ts: `taskIdentifier: TRunTypes[...]`).
  // Newest-first so "latest" derivations are index 0.
  const sortedRuns = React.useMemo(
    () =>
      runs
        .filter((r) => r.taskIdentifier === "room-agent")
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    [runs]
  )
  const lastRun = sortedRuns[0]
  const activeRun = React.useMemo(
    () => sortedRuns.find((r) => !isFinalStatus(r.status)),
    [sortedRuns]
  )

  // Overlay persists after completion: prefer the active run, fall back to the
  // last. Keyed on the serialized map so its identity only changes with content
  // (so the shell's sync effect doesn't clobber a manual focus every render).
  const overlaySource = activeRun ?? lastRun
  const overlayJson = overlaySource?.metadata?.map
    ? JSON.stringify(overlaySource.metadata.map)
    : null
  const overlay = React.useMemo<MapOverlay | null>(
    () => (overlayJson ? (JSON.parse(overlayJson) as MapOverlay) : null),
    [overlayJson]
  )

  const status = React.useMemo(
    () => asStatus(activeRun?.metadata?.status),
    [activeRun]
  )

  const timeline = React.useMemo<AgentTimelineEntry[] | undefined>(() => {
    const t = overlaySource?.metadata?.timeline
    return Array.isArray(t) ? (t as unknown as AgentTimelineEntry[]) : undefined
  }, [overlaySource])

  const progress: AgentProgress = {
    routesDone: asNumber(overlaySource?.metadata?.routesDone),
    routesTotal: asNumber(overlaySource?.metadata?.routesTotal),
  }

  const { parts } = useRealtimeStream<string>(
    activeRun?.id ?? "",
    AGENT_STREAM_ID,
    {
      accessToken: token ?? undefined,
      enabled: !!token && !!activeRun?.id,
    }
  )
  const streamText = parts.join("")

  return {
    token,
    activeRun,
    lastRun,
    status,
    overlay,
    timeline,
    progress,
    streamText,
    isActive: !!activeRun,
  }
}
