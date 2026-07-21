"use client"

import { CircleNotchIcon } from "@phosphor-icons/react/dist/csr/CircleNotch"

import { Marker, MarkerContent, MarkerIcon } from "@workspace/ui/components/marker"

import type {
  AgentProgress,
  AgentStatus,
  AgentTimelineEntry,
} from "@/hooks/use-room-agent"

// The streamed assistant text is an ephemeral "typing" preview (ADR 0012) —
// the durable send_chat message arrives separately as a normal chat message —
// so it's clipped rather than shown in full.
const PREVIEW_MAX = 200

/**
 * Live agent activity, rendered under the newest message while a run is in
 * flight. A shimmering status line (with routing progress when routing), an
 * optional muted preview of the agent's streaming reply, and a collapsible
 * timeline of everything it's done so far.
 */
export function AgentActivity({
  status,
  streamText,
  progress,
  timeline,
}: {
  status: AgentStatus | undefined
  streamText: string
  progress: AgentProgress
  timeline: AgentTimelineEntry[] | undefined
}) {
  const label = status?.label ?? "Working…"
  const routeSuffix =
    status?.phase === "routing" && progress.routesTotal
      ? ` (${progress.routesDone ?? 0}/${progress.routesTotal})`
      : ""

  const preview = streamText.trim()
  const clipped =
    preview.length > PREVIEW_MAX ? `${preview.slice(0, PREVIEW_MAX)}…` : preview

  return (
    <div className="mt-1 flex flex-col gap-1">
      <Marker>
        <MarkerIcon>
          <CircleNotchIcon className="size-3.5 animate-spin" />
        </MarkerIcon>
        <MarkerContent className="shimmer">
          {label}
          {routeSuffix}
        </MarkerContent>
      </Marker>

      {clipped ? (
        <p className="pl-5 text-[11px] leading-snug text-muted-foreground/80 italic">
          {clipped}
        </p>
      ) : null}

      {timeline && timeline.length > 0 ? (
        <details className="group pl-5">
          <summary className="cursor-pointer list-none text-[11px] text-muted-foreground/70 outline-none hover:text-muted-foreground">
            <span className="underline-offset-2 group-open:underline">
              Activity
            </span>
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 border-l border-border pl-2">
            {timeline.map((entry, i) => (
              <li
                key={`${entry.at}-${i}`}
                className="text-[11px] text-muted-foreground/70"
              >
                {entry.label}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  )
}
