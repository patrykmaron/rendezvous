"use client"

import * as React from "react"

import { useEventListener } from "@liveblocks/react/suspense"

import type { PlanResponse, VoteTally } from "@/lib/types"

// The plan slice RoomView owns and threads to the chat panel (and, in later
// phases, the map-pane carousel). See ADR 0014/0015 for the nudge model.
export type UsePlanResult = {
  // Full server response (retained plan + votes + decision), or null pre-fetch.
  data: PlanResponse | null
  // Convenience mirrors of data flags (false while null).
  replanning: boolean
  updateFailed: boolean
  refetch: () => void
}

/**
 * Owns the room's plan state as a thin fetcher of GET /api/rooms/[id]/plan. The
 * server does plan retention (PlanResponse.plan is the newest COMPLETE
 * snapshot), so this hook never keeps its own retained copy — it just refetches
 * on the right signals:
 *   - on mount,
 *   - when a run reaches a final status (completedRunId, deduped so a given run
 *     refetches at most once even across re-renders),
 *   - on the `plan:updated` nudge (finalize-plan fires it as a belt-and-braces
 *     partner to completedRunId).
 * `vote:update` / `decided:update` patch the current response in place (no
 * refetch — the broadcast carries the full post-change tally / decision).
 */
export function usePlan(
  roomId: string,
  sessionToken: string,
  completedRunId: string | undefined,
  participantId: string
): UsePlanResult {
  const [data, setData] = React.useState<PlanResponse | null>(null)

  const loadPlan = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/rooms/${roomId}/plan`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      })
      if (!res.ok) return
      const next = (await res.json()) as PlanResponse
      setData(next)
    } catch {
      // Non-fatal: keep whatever we last had; the next nudge retries.
    }
  }, [roomId, sessionToken])

  React.useEffect(() => {
    // loadPlan setState()s only after its awaited fetch resolves, not
    // synchronously in the effect body, so it doesn't cascade renders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPlan()
  }, [loadPlan])

  // Refetch once per completed run (dedupe belt-and-braces with plan:updated).
  const refetchedRunRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!completedRunId || refetchedRunRef.current === completedRunId) return
    refetchedRunRef.current = completedRunId
    void loadPlan()
  }, [completedRunId, loadPlan])

  useEventListener(({ event }) => {
    if (event.type === "plan:updated") {
      void loadPlan()
    } else if (event.type === "vote:update") {
      // Patch the affected candidate's tally in place — the broadcast carries
      // the FULL post-change voter list (receivers replace, never increment).
      // Ignore votes for a snapshot other than the displayed plan (a race
      // against a re-plan that already superseded it).
      setData((prev) => {
        if (!prev || !prev.plan || prev.plan.id !== event.snapshotId) return prev
        const idx = prev.votes.findIndex(
          (v) => v.candidateH3 === event.candidateH3
        )
        let nextVotes: VoteTally[]
        if (event.voterIds.length === 0) {
          nextVotes = idx >= 0 ? prev.votes.filter((_, i) => i !== idx) : prev.votes
        } else {
          const tally: VoteTally = {
            candidateH3: event.candidateH3,
            voterIds: event.voterIds,
          }
          if (idx >= 0) {
            nextVotes = prev.votes.slice()
            nextVotes[idx] = tally
          } else {
            nextVotes = [...prev.votes, tally]
          }
        }
        const mine = event.voterIds.includes(participantId)
        const hadMine = prev.myVotes.includes(event.candidateH3)
        const nextMyVotes = mine
          ? hadMine
            ? prev.myVotes
            : [...prev.myVotes, event.candidateH3]
          : prev.myVotes.filter((h3) => h3 !== event.candidateH3)
        return { ...prev, votes: nextVotes, myVotes: nextMyVotes }
      })
    } else if (event.type === "decided:update") {
      setData((prev) => (prev ? { ...prev, decision: event.decision } : prev))
    }
  })

  return {
    data,
    replanning: data?.replanning ?? false,
    updateFailed: data?.updateFailed ?? false,
    refetch: loadPlan,
  }
}
