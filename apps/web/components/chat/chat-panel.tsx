"use client"

import * as React from "react"

import { useEventListener } from "@liveblocks/react/suspense"

import { TooltipProvider } from "@workspace/ui/components/tooltip"

import { sendMessage, toggleReaction } from "@/app/actions/chat"
import type { ChatAgentActivity } from "@/hooks/use-room-agent"
import type { RoomSession } from "@/lib/session"
import type {
  ChatMessage,
  MessageReactionSummary,
  PlanCandidate,
  PlanSnapshotView,
  RoomDecision,
  VoteTally,
} from "@/lib/types"

import { Composer } from "./composer"
import { ConstraintChips } from "./constraint-chips"
import { MessageList } from "./message-list"
import { TypingRow } from "./typing-row"

const OPTIMISTIC_PREFIX = "tmp:"

/**
 * Applies a single `reaction:update` nudge to a message's reaction summaries.
 * Reactions are driven entirely by the broadcast (including the reactor's own
 * echo), so this is the one place counts change — no optimistic local patch,
 * which keeps add/remove from double-counting against their own echo.
 */
function applyReaction(
  reactions: MessageReactionSummary[],
  emoji: string,
  action: "added" | "removed",
  name: string,
  mine: boolean
): MessageReactionSummary[] {
  const next = reactions.map((r) => ({ ...r, names: [...r.names] }))
  const idx = next.findIndex((r) => r.emoji === emoji)

  if (action === "added") {
    if (idx >= 0) {
      const r = next[idx]!
      // Guard against a duplicated delivery of the same add.
      if (r.names.includes(name) && !mine) return reactions
      next[idx] = {
        emoji,
        count: r.count + 1,
        names: [...r.names, name],
        reactedByMe: r.reactedByMe || mine,
      }
    } else {
      next.push({ emoji, count: 1, names: [name], reactedByMe: mine })
    }
    return next
  }

  // removed
  if (idx < 0) return reactions
  const r = next[idx]!
  const count = r.count - 1
  const nameAt = r.names.indexOf(name)
  const names =
    nameAt >= 0
      ? [...r.names.slice(0, nameAt), ...r.names.slice(nameAt + 1)]
      : r.names
  if (count <= 0) {
    next.splice(idx, 1)
  } else {
    next[idx] = {
      emoji,
      count,
      names,
      reactedByMe: mine ? false : r.reactedByMe,
    }
  }
  return next
}

/**
 * The room's chat panel: owns the message list state, hydrates history over
 * the authenticated messages API, and folds in realtime nudges (message:new,
 * reaction:update) per ADR 0012. Durable writes go through the chat server
 * actions; presence/typing stay ephemeral in Liveblocks. The plan slice
 * (retained plan + votes + decision) is owned by RoomView (usePlan) and passed
 * in — this panel is a read-only consumer of it.
 */
export function ChatPanel({
  roomId,
  session,
  agent,
  plan,
  eventAt,
  replanning,
  updateFailed,
  updatingLabel,
  votes,
  myVotes,
  decision,
  myColor,
  isHost,
  onFocusCandidate,
  onVenuePreview,
  onToggleVote,
  onDecide,
}: {
  roomId: string
  session: RoomSession
  agent: ChatAgentActivity
  // Plan slice from RoomView's usePlan (see hooks/use-plan.ts).
  plan: PlanSnapshotView | null
  eventAt: string | null
  replanning: boolean
  updateFailed: boolean
  updatingLabel: string
  votes: VoteTally[]
  myVotes: string[]
  decision: RoomDecision | null
  myColor: string
  isHost: boolean
  onFocusCandidate: (candidate: PlanCandidate) => void
  onVenuePreview: (candidate: PlanCandidate, venueIndex: number) => void
  onToggleVote: (candidateH3: string) => void
  onDecide: (candidateH3: string) => void
}) {
  const [messages, setMessages] = React.useState<ChatMessage[]>([])

  // participantId -> display name, used to label reactors in `reaction:update`
  // nudges (which carry only the id). Seeded from history + the members list,
  // plus my own identity below.
  const namesRef = React.useRef<Map<string, string>>(new Map())
  React.useEffect(() => {
    namesRef.current.set(session.participantId, session.name)
  }, [session.participantId, session.name])

  const loadMembers = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/rooms/${roomId}/members`)
      if (!res.ok) return
      const members: Array<{ participantId: string; name: string }> =
        await res.json()
      for (const m of members) namesRef.current.set(m.participantId, m.name)
    } catch {
      // Non-fatal: reactor names fall back to a generic label.
    }
  }, [roomId])

  const loadHistory = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/rooms/${roomId}/messages`, {
        headers: { Authorization: `Bearer ${session.sessionToken}` },
      })
      if (!res.ok) return
      const data: ChatMessage[] = await res.json()
      for (const m of data) {
        if (m.participantId && m.author) {
          namesRef.current.set(m.participantId, m.author.name)
        }
      }
      setMessages(data)
    } catch {
      // Non-fatal: the panel stays empty until the next message nudge lands.
    }
  }, [roomId, session.sessionToken])

  React.useEffect(() => {
    void loadMembers()
    // loadHistory setState()s only after its await resolves, not synchronously
    // in the effect body, so it doesn't cascade renders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadHistory()
  }, [loadMembers, loadHistory])

  // Append a durable message, replacing a matching optimistic placeholder and
  // deduping by id (the sender sees both the action's return and its own
  // message:new echo).
  const appendMessage = React.useCallback((incoming: ChatMessage) => {
    // Defensive: a broadcast may arrive without `reactions` (older senders /
    // the task-side broadcaster); the message list reads it unconditionally.
    const message: ChatMessage = {
      ...incoming,
      reactions: incoming.reactions ?? [],
    }
    setMessages((prev) => {
      if (prev.some((m) => m.id === message.id)) return prev
      const optimisticIdx = prev.findIndex(
        (m) =>
          m.id.startsWith(OPTIMISTIC_PREFIX) &&
          m.participantId === message.participantId &&
          m.content === message.content
      )
      if (optimisticIdx >= 0) {
        const next = prev.slice()
        next[optimisticIdx] = message
        return next
      }
      return [...prev, message]
    })
  }, [])

  useEventListener(({ event }) => {
    if (event.type === "message:new") {
      appendMessage(event.message)
    } else if (event.type === "reaction:update") {
      let name = namesRef.current.get(event.participantId)
      if (!name) {
        name = "Someone"
        void loadMembers()
      }
      const resolvedName = name
      const mine = event.participantId === session.participantId
      setMessages((prev) =>
        prev.map((m) =>
          m.id === event.messageId
            ? {
                ...m,
                reactions: applyReaction(
                  m.reactions,
                  event.emoji,
                  event.action,
                  resolvedName,
                  mine
                ),
              }
            : m
        )
      )
    }
  })

  const handleSubmit = React.useCallback(
    (content: string) => {
      const tempId = `${OPTIMISTIC_PREFIX}${crypto.randomUUID()}`
      const optimistic: ChatMessage = {
        id: tempId,
        roomId,
        participantId: session.participantId,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
        author: { name: session.name, color: session.color },
        reactions: [],
      }
      setMessages((prev) => [...prev, optimistic])

      React.startTransition(async () => {
        try {
          const saved = await sendMessage(
            session.sessionToken,
            roomId,
            content
          )
          appendMessage(saved)
        } catch (err) {
          setMessages((prev) => prev.filter((m) => m.id !== tempId))
          console.error("sendMessage failed", err)
        }
      })
    },
    [roomId, session, appendMessage]
  )

  // Reactions are broadcast-driven (see applyReaction); the click just fires
  // the durable toggle and the resulting nudge updates every tab, including
  // this one.
  const handleToggleReaction = React.useCallback(
    (messageId: string, emoji: string) => {
      React.startTransition(async () => {
        try {
          await toggleReaction(session.sessionToken, roomId, messageId, emoji)
        } catch (err) {
          console.error("toggleReaction failed", err)
        }
      })
    },
    [roomId, session.sessionToken]
  )

  return (
    <TooltipProvider delay={200}>
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <MessageList
          messages={messages}
          myParticipantId={session.participantId}
          plan={plan}
          eventAt={eventAt}
          replanning={replanning}
          updateFailed={updateFailed}
          updatingLabel={updatingLabel}
          votes={votes}
          myVotes={myVotes}
          decision={decision}
          myColor={myColor}
          isHost={isHost}
          agent={agent}
          onFocus={onFocusCandidate}
          onVenuePreview={onVenuePreview}
          onToggleVote={onToggleVote}
          onDecide={onDecide}
          onToggleReaction={handleToggleReaction}
        />
        <TypingRow />
        <ConstraintChips roomId={roomId} session={session} />
        <Composer onSubmit={handleSubmit} />
      </div>
    </TooltipProvider>
  )
}
