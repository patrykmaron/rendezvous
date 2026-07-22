"use client"

import { ArrowsClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowsClockwise"
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle"
import { HeartIcon } from "@phosphor-icons/react/dist/csr/Heart"
import { MapPinIcon } from "@phosphor-icons/react/dist/csr/MapPin"
import { TrophyIcon } from "@phosphor-icons/react/dist/csr/Trophy"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import type {
  PlanCandidate,
  PlanSnapshotView,
  RoomDecision,
  VoteTally,
} from "@/lib/types"

function mins(value: number): string {
  return `${Math.round(value)}m`
}

/** Ranked colour badge (gold/silver/bronze tint for the podium). Exported for
 *  the map-side venue carousel's area bar. */
export function RankBadge({ rank }: { rank: number }) {
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

/** Approval-vote heart + count. Its own <button> (never nested in the row's
 *  focus button — invalid HTML). Filled + tinted the caller's colour when mine. */
function VoteHeart({
  count,
  mine,
  color,
  disabled,
  onClick,
}: {
  count: number
  mine: boolean
  color: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={mine}
      aria-label={mine ? "Remove your vote" : "Vote for this area"}
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors outline-none hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-50"
    >
      <HeartIcon
        weight={mine ? "fill" : "regular"}
        className="size-3.5"
        style={mine ? { color } : undefined}
      />
      <span className="tabular-nums">{count}</span>
    </button>
  )
}

function CandidateRow({
  candidate,
  voteCount,
  mine,
  myColor,
  voteDisabled,
  locked,
  showLockIn,
  onFocus,
  onVenuePreview,
  onToggleVote,
  onDecide,
}: {
  candidate: PlanCandidate
  voteCount: number
  mine: boolean
  myColor: string
  voteDisabled: boolean
  // This row is the locked-in decision (gold-tinted, badge, no vote/lock-in).
  locked: boolean
  // Host + leading + not decided + not replanning → show the "Lock it in" button.
  showLockIn: boolean
  onFocus: (candidate: PlanCandidate) => void
  onVenuePreview: (candidate: PlanCandidate, venueIndex: number) => void
  onToggleVote: (candidateH3: string) => void
  onDecide: (candidateH3: string) => void
}) {
  const venues = candidate.venues.slice(0, 3)
  const showVenues = venues.length > 0
  return (
    // The venue chips and vote/lock controls below are their own <button>s —
    // nesting them inside the row's focus button would be invalid HTML, so this
    // cell is a plain div and the focus target is just the top button.
    <div className={cn("flex flex-col", locked && "border-l-2 border-l-amber-400")}>
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
      </button>

      {showVenues ? (
        <div className="flex flex-wrap items-center gap-1 px-3 pb-1.5 pl-7">
          <MapPinIcon
            weight="fill"
            className="size-3 shrink-0 text-muted-foreground"
          />
          {venues.map((v, i) => (
            <button
              key={`${candidate.h3}-venue-${i}`}
              type="button"
              onClick={() => onVenuePreview(candidate, i)}
              title={v.name}
              className="max-w-[9rem] truncate rounded-full border border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors outline-none hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:bg-muted"
            >
              {v.name}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-2 px-3 pb-2.5 pl-7">
        {locked ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
            <CheckCircleIcon weight="fill" className="size-3.5" />
            Locked in
          </span>
        ) : (
          <VoteHeart
            count={voteCount}
            mine={mine}
            color={myColor}
            disabled={voteDisabled}
            onClick={() => onToggleVote(candidate.h3)}
          />
        )}
        {showLockIn ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="ml-auto"
            onClick={() => onDecide(candidate.h3)}
          >
            <CheckCircleIcon />
            Lock it in
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The agent's results card, pinned at the bottom of the message list. `plan` is
 * the retained plan from usePlan (server keeps the newest COMPLETE snapshot), so
 * this card stays put while a re-plan runs. Renders the top-3 candidate areas;
 * a FAILED snapshot collapses to a thin muted row, and running/pending render
 * nothing — now only reachable pre-first-plan (no complete plan was ever
 * retained), where AgentActivity covers the gap. Clicking a row focuses the map.
 *
 * `replanning` shows a spinning badge + border tint over the retained plan;
 * `updateFailed` adds a note that the previous plan is still shown. Each row
 * carries an approval-vote heart (`votes` / `myVotes`, disabled while
 * `replanning` or once decided); the host sees a "Lock it in" button on the
 * leading area, and once `decision` is set that row renders locked. The richer
 * map-side carousel + DecidedBanner are a later phase.
 */
export function PlanCard({
  plan,
  replanning,
  updateFailed,
  updatingLabel,
  votes,
  myVotes,
  decision,
  myColor,
  isHost,
  onFocus,
  onVenuePreview,
  onToggleVote,
  onDecide,
}: {
  plan: PlanSnapshotView
  replanning: boolean
  updateFailed: boolean
  updatingLabel: string
  votes: VoteTally[]
  myVotes: string[]
  decision: RoomDecision | null
  myColor: string
  isHost: boolean
  onFocus: (candidate: PlanCandidate) => void
  onVenuePreview: (candidate: PlanCandidate, venueIndex: number) => void
  onToggleVote: (candidateH3: string) => void
  onDecide: (candidateH3: string) => void
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

  const voteCountByH3 = new Map(votes.map((v) => [v.candidateH3, v.voterIds.length]))
  const myVoteSet = new Set(myVotes)
  // Hearts are disabled during a re-plan (votes would land on a snapshot about
  // to be superseded — critique §E) and once a decision is locked in.
  const voteDisabled = replanning || decision !== null

  // Leading area = most approvals, tie-break by rank (lowest wins) — the row
  // that gets the host's "Lock it in" button. With no votes yet this is rank 1.
  const leadingH3 =
    candidates.reduce<PlanCandidate | null>((best, c) => {
      if (!best) return c
      const cv = voteCountByH3.get(c.h3) ?? 0
      const bv = voteCountByH3.get(best.h3) ?? 0
      if (cv > bv) return c
      if (cv === bv && c.rank < best.rank) return c
      return best
    }, null)?.h3 ?? null

  const canLockIn = isHost && !replanning && decision === null

  return (
    <div
      className={cn(
        "mt-2 overflow-hidden border bg-card",
        replanning ? "border-primary/50" : "border-border"
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <TrophyIcon weight="fill" className="size-4 text-primary" />
        <span className="text-xs font-medium">Fair spots to meet</span>
        {replanning ? (
          <span className="ml-auto flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
            <ArrowsClockwiseIcon className="size-3 shrink-0 animate-spin" />
            <span className="truncate">{updatingLabel}</span>
          </span>
        ) : null}
      </div>
      {updateFailed ? (
        <div className="border-b border-border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
          Couldn&apos;t update — showing the previous plan.
        </div>
      ) : null}
      <div className="divide-y divide-border">
        {candidates.map((candidate) => (
          <CandidateRow
            key={candidate.h3}
            candidate={candidate}
            voteCount={voteCountByH3.get(candidate.h3) ?? 0}
            mine={myVoteSet.has(candidate.h3)}
            myColor={myColor}
            voteDisabled={voteDisabled}
            locked={decision?.candidateH3 === candidate.h3}
            showLockIn={canLockIn && candidate.h3 === leadingH3}
            onFocus={onFocus}
            onVenuePreview={onVenuePreview}
            onToggleVote={onToggleVote}
            onDecide={onDecide}
          />
        ))}
      </div>
    </div>
  )
}
