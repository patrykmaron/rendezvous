"use client"

import * as React from "react"

import { Marker, MarkerContent } from "@workspace/ui/components/marker"
import { MessageGroup } from "@workspace/ui/components/message"
import { ScrollArea } from "@workspace/ui/components/scroll-area"

import type { ChatAgentActivity } from "@/hooks/use-room-agent"
import type {
  ChatMessage,
  PlanCandidate,
  PlanSnapshotView,
  RoomDecision,
  VoteTally,
} from "@/lib/types"

import { AgentActivity } from "./agent-activity"
import { MessageItem } from "./message-item"
import { PlanCard } from "./plan-card"

const FIVE_MINUTES = 5 * 60 * 1000
const ONE_DAY = 24 * 60 * 60 * 1000
// Auto-follow the conversation only when the reader is already within this many
// pixels of the bottom — never yank them away from older messages they're reading.
const NEAR_BOTTOM_PX = 80

function startOfDayMs(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function formatDay(iso: string): string {
  const d = new Date(iso)
  const key = startOfDayMs(d)
  const today = startOfDayMs(new Date())
  if (key === today) return "Today"
  if (key === today - ONE_DAY) return "Yesterday"
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  })
}

type Row =
  | { kind: "divider"; key: string; label: string }
  | { kind: "group"; key: string; items: ChatMessage[] }

export function MessageList({
  messages,
  myParticipantId,
  plan,
  replanning,
  updateFailed,
  updatingLabel,
  votes,
  myVotes,
  decision,
  agent,
  onFocus,
  onVenuePreview,
  onToggleReaction,
}: {
  messages: ChatMessage[]
  myParticipantId: string
  plan: PlanSnapshotView | null
  replanning: boolean
  updateFailed: boolean
  updatingLabel: string
  votes: VoteTally[]
  myVotes: string[]
  decision: RoomDecision | null
  agent: ChatAgentActivity
  onFocus: (candidate: PlanCandidate) => void
  onVenuePreview: (candidate: PlanCandidate, venueIndex: number) => void
  onToggleReaction: (messageId: string, emoji: string) => void
}) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const nearBottomRef = React.useRef(true)

  const rows = React.useMemo<Row[]>(() => {
    const out: Row[] = []
    let group: Extract<Row, { kind: "group" }> | null = null
    let lastDayKey: number | null = null
    let lastTime = 0
    let lastAuthorKey: string | null = null

    for (const m of messages) {
      const time = new Date(m.createdAt).getTime()
      const dayKey = startOfDayMs(new Date(m.createdAt))
      // Assistant/system rows (null participant) group under one persona key.
      const authorKey = m.participantId ?? `persona:${m.role}`
      const newDay = lastDayKey === null || dayKey !== lastDayKey

      if (newDay) {
        out.push({
          kind: "divider",
          key: `div-${dayKey}`,
          label: formatDay(m.createdAt),
        })
        group = null
      }

      const canGroup =
        group !== null &&
        !newDay &&
        authorKey === lastAuthorKey &&
        time - lastTime < FIVE_MINUTES

      if (canGroup && group) {
        group.items.push(m)
      } else {
        group = { kind: "group", key: `grp-${m.id}`, items: [m] }
        out.push(group)
      }

      lastDayKey = dayKey
      lastTime = time
      lastAuthorKey = authorKey
    }

    return out
  }, [messages])

  // Track whether the reader is pinned to the bottom, so new-message follow is
  // opt-in based on their current scroll position.
  React.useEffect(() => {
    const viewport = containerRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    )
    if (!viewport) return
    const onScroll = () => {
      nearBottomRef.current =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
        NEAR_BOTTOM_PX
    }
    viewport.addEventListener("scroll", onScroll, { passive: true })
    return () => viewport.removeEventListener("scroll", onScroll)
  }, [])

  // After new content lands, stick to the bottom only if we were already there.
  React.useLayoutEffect(() => {
    if (!nearBottomRef.current) return
    const viewport = containerRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    )
    if (!viewport) return
    viewport.scrollTop = viewport.scrollHeight
    // Also follow the agent's live status/stream while it's working.
  }, [messages, plan, agent.isActive, agent.streamText, agent.status?.label])

  return (
    <div ref={containerRef} className="min-h-0 flex-1">
      <ScrollArea className="h-full">
        <div className="flex flex-col gap-3 p-3">
          {messages.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              No messages yet — say hello, or mention @agent to find fair spots
              to meet.
            </p>
          ) : null}

          {rows.map((row) =>
            row.kind === "divider" ? (
              <Marker key={row.key} variant="separator" className="my-1">
                <MarkerContent>{row.label}</MarkerContent>
              </Marker>
            ) : (
              <MessageGroup key={row.key}>
                {row.items.map((m, i) => (
                  <MessageItem
                    key={m.id}
                    message={m}
                    own={m.participantId === myParticipantId}
                    isFirstInGroup={i === 0}
                    isLastInGroup={i === row.items.length - 1}
                    onToggleReaction={onToggleReaction}
                  />
                ))}
              </MessageGroup>
            )
          )}

          {plan ? (
            <PlanCard
              plan={plan}
              replanning={replanning}
              updateFailed={updateFailed}
              updatingLabel={updatingLabel}
              votes={votes}
              myVotes={myVotes}
              decision={decision}
              onFocus={onFocus}
              onVenuePreview={onVenuePreview}
            />
          ) : null}

          {agent.isActive ? (
            <AgentActivity
              status={agent.status}
              streamText={agent.streamText}
              progress={agent.progress}
              timeline={agent.timeline}
            />
          ) : null}
        </div>
      </ScrollArea>
    </div>
  )
}
