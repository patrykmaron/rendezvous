import type { PlanCandidate } from "@/lib/types"

// Pure, framework-agnostic plan helpers shared across the room surfaces (chat
// plan card, map overlay, and — in later phases — the venue carousel). No
// React / DB / server imports so any of them can call it freely.

/**
 * A candidate's venues, filtered to finite coordinates and paired with the
 * overlay pin id `focusCandidate` assigns them (`venue-<h3>-<index>`, indexed
 * within this filtered list — matches `publishFinalOverlay` in room-agent.ts).
 * Shared by room-shell's `focusCandidate` / venue-chip handler (and later the
 * venue carousel) so a chip or card click always resolves the id its own pin
 * actually has.
 */
export function candidateVenuePins(
  candidate: PlanCandidate
): Array<{ venue: PlanCandidate["venues"][number]; id: string }> {
  return candidate.venues
    .filter((v) => Number.isFinite(v.lat) && Number.isFinite(v.lng))
    .map((venue, i) => ({ venue, id: `venue-${candidate.h3}-${i}` }))
}
