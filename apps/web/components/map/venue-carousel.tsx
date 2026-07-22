"use client"

import * as React from "react"

import { ArrowsClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowsClockwise"
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown"
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft"
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight"
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle"
import { HeartIcon } from "@phosphor-icons/react/dist/csr/Heart"
import { MapPinIcon } from "@phosphor-icons/react/dist/csr/MapPin"
import { SealCheckIcon } from "@phosphor-icons/react/dist/csr/SealCheck"
import { StarIcon } from "@phosphor-icons/react/dist/csr/Star"
import { TrophyIcon } from "@phosphor-icons/react/dist/csr/Trophy"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import { RankBadge } from "@/components/chat/plan-card"
import { usePlacePreview } from "@/hooks/use-place-preview"
import { candidateVenuePins } from "@/lib/plan-utils"
import type {
  PlacePreviewTarget,
  PlanCandidate,
  RoomDecision,
  VoteTally,
} from "@/lib/types"

import { DecidedBanner } from "./decided-banner"

// Cap venues per area so the row can't run away on a dense candidate; the pin
// ids stay index-aligned with candidateVenuePins (the filtered list).
const MAX_VENUES_PER_AREA = 5

type Card = {
  candidate: PlanCandidate
  venue: PlanCandidate["venues"][number]
  venueIndex: number
  pinId: string
}

function mins(value: number): string {
  return `${Math.round(value)}m`
}

function previewTargetFor(card: Card): PlacePreviewTarget {
  return {
    id: card.pinId,
    name: card.venue.name,
    lat: card.venue.lat,
    lng: card.venue.lng,
    category: card.venue.category,
    fsqPlaceId: card.venue.fsqPlaceId,
    googlePlaceId: card.venue.googlePlaceId,
  }
}

/** One venue card. The ACTIVE card lazily fetches its photo (usePlacePreview);
 *  inactive cards render from plan data only (rating/category come free). */
function VenueCard({
  card,
  active,
  dim,
  roomId,
  sessionToken,
  innerRef,
  onClick,
}: {
  card: Card
  active: boolean
  dim: boolean
  roomId: string
  sessionToken: string
  innerRef: (el: HTMLButtonElement | null) => void
  onClick: () => void
}) {
  const preview = usePlacePreview(
    active ? previewTargetFor(card) : null,
    roomId,
    sessionToken
  )
  const photoUrl = preview.kind === "ok" ? preview.place.photoUrl : null
  const rating = card.venue.rating ?? null
  const ratingCount = card.venue.userRatingCount ?? null

  return (
    <button
      ref={innerRef}
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-52 shrink-0 snap-center flex-col border bg-card text-left transition-[colors,opacity] outline-none",
        active
          ? "border-foreground"
          : "border-border opacity-90 hover:opacity-100",
        dim && "opacity-40 hover:opacity-60"
      )}
    >
      <div className="relative h-20 w-full overflow-hidden bg-muted">
        {photoUrl ? (
          // Google's googleusercontent CDN photo — see place-preview-card.tsx.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <MapPinIcon weight="fill" className="size-5" />
          </div>
        )}
        <span className="absolute top-1 left-1 flex items-center gap-1">
          <RankBadge rank={card.candidate.rank} />
        </span>
      </div>
      <div className="flex flex-col gap-1 p-2">
        <div className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {card.venue.name}
          </span>
          {card.venue.verified ? (
            <SealCheckIcon
              weight="fill"
              className="size-3 shrink-0 text-primary"
            />
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {rating !== null ? (
            <span className="flex items-center gap-0.5">
              <StarIcon weight="fill" className="size-3 text-amber-500" />
              <span className="tabular-nums text-foreground">{rating}</span>
              {ratingCount !== null ? (
                <span className="tabular-nums">
                  ({ratingCount.toLocaleString()})
                </span>
              ) : null}
            </span>
          ) : null}
          {card.venue.category ? (
            <span className="truncate">{card.venue.category}</span>
          ) : null}
        </div>
      </div>
    </button>
  )
}

/**
 * Bottom-center map-pane overlay showing the top-3 areas' venues as a CSS
 * scroll-snap card row, with an area bar bound to the active card (rank, name,
 * avg/max, approval vote + host lock-in). A sibling of RoomMap in #map-pane —
 * plan/vote/decision come from RoomView (usePlan). The active card ↔ map sync
 * runs through `activeVenue` / `onActiveVenue` (focusCandidate draws the routes
 * and flies the camera). Photo fetches are lazy: only the active card fetches.
 */
export function VenueCarousel({
  candidates,
  votes,
  myVotes,
  decision,
  eventAt,
  replanning,
  isHost,
  myColor,
  roomId,
  sessionToken,
  getMemberColor,
  activeVenue,
  onActiveVenue,
  onToggleVote,
  onDecide,
  expanded,
  onExpandedChange,
}: {
  candidates: PlanCandidate[]
  votes: VoteTally[]
  myVotes: string[]
  decision: RoomDecision | null
  eventAt: string | null
  replanning: boolean
  isHost: boolean
  myColor: string
  roomId: string
  sessionToken: string
  getMemberColor: (participantId: string) => string | undefined
  activeVenue: { h3: string; index: number } | null
  onActiveVenue: (candidate: PlanCandidate, venueIndex: number) => void
  onToggleVote: (candidateH3: string) => void
  onDecide: (candidateH3: string) => void
  expanded: boolean
  onExpandedChange: (next: boolean) => void
}) {
  const cards = React.useMemo<Card[]>(
    () =>
      candidates.flatMap((candidate) =>
        candidateVenuePins(candidate)
          .slice(0, MAX_VENUES_PER_AREA)
          .map(({ venue, id }, venueIndex) => ({
            candidate,
            venue,
            venueIndex,
            pinId: id,
          }))
      ),
    [candidates]
  )

  const [activeIndex, setActiveIndex] = React.useState(0)
  const rowRef = React.useRef<HTMLDivElement>(null)
  const cardRefs = React.useRef<Array<HTMLButtonElement | null>>([])

  // External focus (a venue-pin or chat-chip click sets activeVenue): sync the
  // internal index to it. Guarded so it never fights the internal scroll report.
  React.useEffect(() => {
    if (!activeVenue) return
    const idx = cards.findIndex(
      (c) =>
        c.candidate.h3 === activeVenue.h3 && c.venueIndex === activeVenue.index
    )
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (idx >= 0 && idx !== activeIndex) setActiveIndex(idx)
  }, [activeVenue, cards, activeIndex])

  // Clamp when the card set shrinks (a new plan with fewer venues).
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (activeIndex > cards.length - 1) setActiveIndex(0)
  }, [cards.length, activeIndex])

  // Report the active card to RoomView (focusCandidate: draw routes + fly). Runs
  // on mount for the top card too, so the winner's real geometry reveals with
  // the carousel. onActiveVenue is a stable useCallback in RoomView.
  const activeCard = cards[activeIndex]
  const activeCandidateH3 = activeCard?.candidate.h3
  const activeCandidateIndex = activeCard?.venueIndex
  React.useEffect(() => {
    if (!activeCard) return
    onActiveVenue(activeCard.candidate, activeCard.venueIndex)
    // Depend on the identity of what's active, not the memoised card object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCandidateH3, activeCandidateIndex, onActiveVenue])

  // Center the active card when it changes (external focus or arrows/keys). A
  // user scroll is detected separately and won't re-trigger a scroll to itself.
  React.useEffect(() => {
    const el = rowRef.current
    const card = cardRefs.current[activeIndex]
    if (!el || !card) return
    const target = card.offsetLeft + card.offsetWidth / 2 - el.clientWidth / 2
    el.scrollTo({ left: target, behavior: "smooth" })
  }, [activeIndex])

  // Scroll-settle → activate the nearest card. Debounced; programmatic scrolls
  // land on the same index so they don't cause a spurious re-report.
  React.useEffect(() => {
    const el = rowRef.current
    if (!el) return
    let raf = 0
    const onScroll = () => {
      window.clearTimeout(raf)
      raf = window.setTimeout(() => {
        const center = el.scrollLeft + el.clientWidth / 2
        let best = 0
        let bestDist = Infinity
        for (let i = 0; i < cardRefs.current.length; i++) {
          const c = cardRefs.current[i]
          if (!c) continue
          const d = Math.abs(c.offsetLeft + c.offsetWidth / 2 - center)
          if (d < bestDist) {
            bestDist = d
            best = i
          }
        }
        setActiveIndex(best)
      }, 120)
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      el.removeEventListener("scroll", onScroll)
      window.clearTimeout(raf)
    }
  }, [])

  const step = React.useCallback(
    (delta: number) => {
      setActiveIndex((i) => Math.min(cards.length - 1, Math.max(0, i + delta)))
    },
    [cards.length]
  )

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowRight") {
        e.preventDefault()
        step(1)
      } else if (e.key === "ArrowLeft") {
        e.preventDefault()
        step(-1)
      }
    },
    [step]
  )

  if (cards.length === 0) return null

  const voteCountByH3 = new Map(votes.map((v) => [v.candidateH3, v.voterIds]))
  const myVoteSet = new Set(myVotes)
  const voteDisabled = replanning || decision !== null

  // Leading area: most approvals, tie-break by rank (lowest wins).
  const leadingH3 =
    candidates.reduce<PlanCandidate | null>((best, c) => {
      if (!best) return c
      const cv = voteCountByH3.get(c.h3)?.length ?? 0
      const bv = voteCountByH3.get(best.h3)?.length ?? 0
      if (cv > bv) return c
      if (cv === bv && c.rank < best.rank) return c
      return best
    }, null)?.h3 ?? null

  const active = activeCard?.candidate
  const activeVoters = active ? (voteCountByH3.get(active.h3) ?? []) : []
  const activeMine = active ? myVoteSet.has(active.h3) : false
  const canLockIn =
    !!active &&
    isHost &&
    !replanning &&
    decision === null &&
    active.h3 === leadingH3

  const totalTally = votes.reduce((sum, v) => sum + v.voterIds.length, 0)

  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-[4.5rem] z-10 md:bottom-3">
      <div className="pointer-events-auto mx-auto w-full max-w-[560px]">
        {expanded ? (
          <>
            {decision ? (
              <DecidedBanner
                decision={decision}
                eventAt={eventAt}
                isHost={isHost}
              />
            ) : (
              <div className="flex h-10 items-center gap-2 border border-border bg-background/95 px-2.5 shadow-md backdrop-blur-sm">
                {active ? <RankBadge rank={active.rank} /> : null}
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {active?.name ?? "Fair spots"}
                </span>
                {replanning ? (
                  <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                    <ArrowsClockwiseIcon className="size-3 animate-spin" />
                    Re-thinking…
                  </span>
                ) : active ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    avg {mins(active.avgMinutes)} · max {mins(active.maxMinutes)}
                  </span>
                ) : null}

                {active ? (
                  <button
                    type="button"
                    disabled={voteDisabled}
                    aria-pressed={activeMine}
                    aria-label={
                      activeMine ? "Remove your vote" : "Vote for this area"
                    }
                    onClick={() => onToggleVote(active.h3)}
                    className="inline-flex shrink-0 items-center gap-1 border border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors outline-none hover:border-foreground/30 hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                  >
                    <HeartIcon
                      weight={activeMine ? "fill" : "regular"}
                      className="size-3.5"
                      style={activeMine ? { color: myColor } : undefined}
                    />
                    <span className="tabular-nums">{activeVoters.length}</span>
                  </button>
                ) : null}

                {activeVoters.length > 0 ? (
                  <span className="flex shrink-0 -space-x-1">
                    {activeVoters.slice(0, 4).map((id) => (
                      <span
                        key={id}
                        className="size-2 rounded-full ring-1 ring-background"
                        style={{
                          backgroundColor:
                            getMemberColor(id) ?? "var(--muted-foreground)",
                        }}
                      />
                    ))}
                  </span>
                ) : null}

                {canLockIn ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="shrink-0"
                    onClick={() => onDecide(active!.h3)}
                  >
                    <CheckCircleIcon />
                    Lock it in
                  </Button>
                ) : null}

                <button
                  type="button"
                  aria-label="Minimise"
                  onClick={() => onExpandedChange(false)}
                  className="shrink-0 text-muted-foreground outline-none hover:text-foreground"
                >
                  <CaretDownIcon className="size-4" />
                </button>
              </div>
            )}

            <div className="relative border-x border-b border-border bg-background/95 shadow-md backdrop-blur-sm">
              <div
                ref={rowRef}
                tabIndex={0}
                role="listbox"
                aria-label="Suggested venues"
                onKeyDown={handleKeyDown}
                className={cn(
                  "flex snap-x snap-mandatory gap-2 overflow-x-auto scroll-smooth p-2 outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                  replanning && "opacity-60"
                )}
              >
                {cards.map((card, i) => (
                  <VenueCard
                    key={card.pinId}
                    card={card}
                    active={i === activeIndex}
                    dim={
                      decision !== null &&
                      decision.candidateH3 !== card.candidate.h3
                    }
                    roomId={roomId}
                    sessionToken={sessionToken}
                    innerRef={(el) => {
                      cardRefs.current[i] = el
                    }}
                    onClick={() => setActiveIndex(i)}
                  />
                ))}
              </div>

              <button
                type="button"
                aria-label="Previous venue"
                disabled={activeIndex === 0}
                onClick={() => step(-1)}
                className="absolute top-1/2 left-1 hidden -translate-y-1/2 items-center justify-center border border-border bg-background/90 p-1 text-muted-foreground shadow-sm outline-none hover:text-foreground disabled:opacity-30 md:flex"
              >
                <CaretLeftIcon className="size-4" />
              </button>
              <button
                type="button"
                aria-label="Next venue"
                disabled={activeIndex >= cards.length - 1}
                onClick={() => step(1)}
                className="absolute top-1/2 right-1 hidden -translate-y-1/2 items-center justify-center border border-border bg-background/90 p-1 text-muted-foreground shadow-sm outline-none hover:text-foreground disabled:opacity-30 md:flex"
              >
                <CaretRightIcon className="size-4" />
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={() => onExpandedChange(true)}
            className="mx-auto flex items-center gap-2 border border-border bg-background/95 px-3 py-1.5 text-xs font-medium shadow-md outline-none backdrop-blur-sm hover:bg-muted"
          >
            <TrophyIcon weight="fill" className="size-4 text-primary" />
            {decision ? (
              <span className="truncate">
                Locked in: {decision.candidateName}
              </span>
            ) : (
              <>
                <span>Fair spots · {cards.length} venues</span>
                {totalTally > 0 ? (
                  <span className="flex items-center gap-0.5 text-muted-foreground">
                    <HeartIcon weight="fill" className="size-3" />
                    <span className="tabular-nums">{totalTally}</span>
                  </span>
                ) : null}
              </>
            )}
          </button>
        )}
      </div>
    </div>
  )
}
