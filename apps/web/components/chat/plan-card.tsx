"use client"

import { MapPinIcon } from "@phosphor-icons/react/dist/csr/MapPin"
import { TrophyIcon } from "@phosphor-icons/react/dist/csr/Trophy"

import { cn } from "@workspace/ui/lib/utils"

import type { PlanCandidate, PlanSnapshotView } from "@/lib/types"

function mins(value: number): string {
  return `${Math.round(value)}m`
}

/** Ranked colour badge (gold/silver/bronze tint for the podium). */
function RankBadge({ rank }: { rank: number }) {
  const tint =
    rank === 1
      ? "bg-amber-400 text-black"
      : rank === 2
        ? "bg-zinc-300 text-black"
        : rank === 3
          ? "bg-orange-400 text-black"
          : "bg-foreground text-background"
  return (
    <span
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
        tint
      )}
    >
      {rank}
    </span>
  )
}

function CandidateRow({
  candidate,
  onFocus,
}: {
  candidate: PlanCandidate
  onFocus: (candidate: PlanCandidate) => void
}) {
  const venues = candidate.venues.slice(0, 3)
  return (
    <button
      type="button"
      onClick={() => onFocus(candidate)}
      className="flex w-full flex-col gap-1.5 px-3 py-2.5 text-left transition-colors outline-none hover:bg-muted focus-visible:bg-muted"
    >
      <div className="flex items-center gap-2">
        <RankBadge rank={candidate.rank} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {candidate.name}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          avg {mins(candidate.avgMinutes)} · max {mins(candidate.maxMinutes)}
        </span>
      </div>

      <div className="flex flex-wrap gap-x-2 gap-y-1 pl-7">
        {candidate.perParticipant.map((p) => (
          <span
            key={p.participantId}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
            title={`${p.name}: ${mins(p.minutes)}`}
          >
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: p.color }}
            />
            <span className="tabular-nums">{mins(p.minutes)}</span>
          </span>
        ))}
      </div>

      {candidate.rank === 1 && venues.length > 0 ? (
        <div className="flex items-start gap-1 pl-7 text-[11px] text-muted-foreground">
          <MapPinIcon weight="fill" className="mt-px size-3 shrink-0" />
          <span className="min-w-0 truncate">
            {venues.map((v) => v.name).join(" · ")}
          </span>
        </div>
      ) : null}
    </button>
  )
}

/**
 * The agent's results card, pinned at the bottom of the message list. Renders
 * the top-3 candidate areas of the latest COMPLETE plan snapshot; a FAILED
 * snapshot collapses to a thin muted row, and running/pending render nothing
 * (the agent-status UI arrives in Task 9). Clicking a row asks the shell to
 * focus the map on that candidate.
 */
export function PlanCard({
  plan,
  onFocus,
}: {
  plan: PlanSnapshotView
  onFocus: (candidate: PlanCandidate) => void
}) {
  if (plan.status === "running" || plan.status === "pending") return null

  if (plan.status === "failed") {
    return (
      <div className="mt-1 border border-border/60 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        Couldn&apos;t work out fair spots this time.
      </div>
    )
  }

  const candidates = [...(plan.result?.candidates ?? [])]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 3)
  if (candidates.length === 0) return null

  return (
    <div className="mt-2 overflow-hidden border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <TrophyIcon weight="fill" className="size-4 text-primary" />
        <span className="text-xs font-medium">Fair spots to meet</span>
      </div>
      <div className="divide-y divide-border">
        {candidates.map((candidate) => (
          <CandidateRow
            key={candidate.h3}
            candidate={candidate}
            onFocus={onFocus}
          />
        ))}
      </div>
    </div>
  )
}
