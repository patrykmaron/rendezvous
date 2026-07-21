"use server"

import { requireMember } from "@/lib/auth"
import { NeedsOriginsError, startAnalysis } from "@/lib/agent-trigger"
import { UUID_RE } from "@/lib/validate"

// Server actions are public HTTP endpoints (callable directly, not just from
// the header button) — membership is proven here first. requireMember throws
// UnauthorizedError for a missing/invalid session; the origins guard is
// ordinary business validation, returned as a typed `needs_origins` result so
// the caller can prompt for start points rather than treating it as an error.

export type AskAgentResult =
  | { ok: true; runId: string; analysisId: string }
  | { ok: false; error: "needs_origins" }

/**
 * Kicks off a room-agent analysis on behalf of the caller. `triggerMessageId`
 * optionally attributes the request to a specific chat message (the @agent
 * mention path passes it; the header button does not). Returns the run + plan
 * ids on success, or a typed needs_origins result when the room has < 2 origins.
 */
export async function askAgent(
  sessionToken: string,
  roomId: string,
  triggerMessageId?: string
): Promise<AskAgentResult> {
  const { participant } = await requireMember(sessionToken, roomId)

  // triggerMessageId is optional attribution only — never trust the caller's
  // value. Drop a malformed id (it would otherwise be rejected by the task's
  // uuid schema at trigger time, wedging the just-inserted snapshot) rather
  // than erroring: the analysis still runs, just without attribution.
  const validTriggerMessageId =
    triggerMessageId && UUID_RE.test(triggerMessageId)
      ? triggerMessageId
      : undefined

  try {
    const { runId, analysisId } = await startAnalysis({
      roomId,
      participantId: participant.id,
      triggerMessageId: validTriggerMessageId,
    })
    return { ok: true, runId, analysisId }
  } catch (err) {
    if (err instanceof NeedsOriginsError) {
      return { ok: false, error: "needs_origins" }
    }
    throw err
  }
}
