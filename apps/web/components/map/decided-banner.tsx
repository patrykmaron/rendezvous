"use client"

import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle"

import { formatEventAt } from "@/components/room/event-time-chip"
import type { RoomDecision } from "@/lib/types"

/**
 * Replaces the carousel's area bar once the host has locked in a spot. Shows the
 * winning area, who decided, and the meeting time (from the room's settings) —
 * plus a muted hint to the host that a re-run is how you change it (there is no
 * undo action; startAnalysis clears the decision).
 */
export function DecidedBanner({
  decision,
  eventAt,
  isHost,
}: {
  decision: RoomDecision
  eventAt: string | null
  isHost: boolean
}) {
  return (
    <div className="flex h-10 items-center gap-2 border border-primary/50 bg-background/95 px-3 shadow-md backdrop-blur-sm">
      <CheckCircleIcon
        weight="fill"
        className="size-4 shrink-0 text-primary"
      />
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="truncate text-xs font-medium">
          Locked in: {decision.candidateName}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          by {decision.decidedBy.name}
          {eventAt ? ` · ${formatEventAt(eventAt)}` : ""}
        </span>
      </div>
      {isHost ? (
        <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
          Re-run to change
        </span>
      ) : null}
    </div>
  )
}
