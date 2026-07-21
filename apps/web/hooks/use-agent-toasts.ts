"use client"

import * as React from "react"

import { toast } from "@workspace/ui/components/sonner"

import {
  asStatus,
  isFinalStatus,
  type RoomAgentState,
} from "@/hooks/use-room-agent"

// Statuses that mean the run failed (as opposed to succeeding or being
// cancelled). A COMPLETED run whose metadata phase is "error" also counts —
// the room-agent catches its own failures and returns normally (failGracefully
// sets phase:error), so a completed run is not necessarily a successful plan.
const FAILURE_STATUSES = new Set([
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "TIMED_OUT",
  "EXPIRED",
])

/**
 * Drives sonner toasts off the room-agent run lifecycle (keyed by run id so
 * one toast morphs loading → success/error in place):
 *   - a run in flight shows/updates a loading toast with the current status
 *     label;
 *   - a COMPLETED run (that actually produced a plan) → success;
 *   - a failed run, or one whose metadata phase is "error" → error.
 *
 * Runs already final at the moment the subscription first delivers data are
 * treated as history (no toast) — only lifecycle transitions observed live fire.
 */
export function useAgentToasts(
  state: Pick<RoomAgentState, "activeRun" | "lastRun" | "status">
): void {
  const { activeRun, lastRun, status } = state

  // run id -> last status label we surfaced (so we only update on change).
  const shownLabels = React.useRef(new Map<string, string>())
  // run ids whose terminal toast has already fired (or that pre-existed).
  const terminalHandled = React.useRef(new Set<string>())
  const seeded = React.useRef(false)

  const activeLabel = status?.label

  React.useEffect(() => {
    // Seed once, the first time any run data arrives: don't toast runs that
    // were already finished before this hook started observing.
    if (!seeded.current) {
      if (!lastRun) return
      seeded.current = true
      if (isFinalStatus(lastRun.status)) {
        terminalHandled.current.add(lastRun.id)
        return
      }
      // else: a run was already in flight — fall through to show its loading.
    }

    // Loading / status-update toast for the in-flight run.
    if (activeRun) {
      const label = activeLabel ?? "Agent is working…"
      if (shownLabels.current.get(activeRun.id) !== label) {
        toast.loading(label, { id: activeRun.id })
        shownLabels.current.set(activeRun.id, label)
      }
    }

    // Terminal toast for the newest run, once, when it reaches a final status.
    if (
      lastRun &&
      isFinalStatus(lastRun.status) &&
      !terminalHandled.current.has(lastRun.id)
    ) {
      terminalHandled.current.add(lastRun.id)
      const phase = asStatus(lastRun.metadata?.status)?.phase
      if (
        lastRun.status === "COMPLETED" &&
        phase !== "error" &&
        phase !== "waiting_input"
      ) {
        toast.success("Plan ready — top spots are on the map", {
          id: lastRun.id,
          duration: 6000,
        })
      } else if (phase === "error" || FAILURE_STATUSES.has(lastRun.status)) {
        toast.error("Analysis failed", { id: lastRun.id })
      } else {
        // CANCELED, or COMPLETED while still waiting for input — nothing to
        // celebrate or mourn; just clear the lingering loading toast.
        toast.dismiss(lastRun.id)
      }
    }
  }, [activeRun, lastRun, activeLabel])
}
