"use server"

import { eq, sql } from "@workspace/db/postgres"
import { withRoomRevision } from "@workspace/db/revision"
import { rooms } from "@workspace/db/schema"

import { maybeAutoReplan } from "@/lib/agent-trigger"
import { requireMember } from "@/lib/auth"
import { broadcastRoomEvent } from "@/lib/liveblocks-server"

// Server actions are public HTTP endpoints (callable directly) — every input is
// validated here, never trusted from the client. requireMember throws
// UnauthorizedError for a missing/invalid session; a malformed time is ordinary
// business-validation, returned as a typed result the chip shows inline.

// London wall-clock "yyyy-MM-ddTHH:mm" (exactly what <input type="datetime-local">
// yields — no zone). Stored verbatim; the routing pipeline splits it with zero
// timezone maths (see ADR / G1 design §4.4).
const EVENT_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
// TfL journey-planner horizon — reject times further out than this.
const MAX_HORIZON_MS = 60 * 24 * 60 * 60 * 1000

export type SetEventTimeResult = { ok: true } | { ok: false; error: string }

/**
 * Sets (or clears, with null) the room's target meeting time. Any member may
 * set it — it's collaborative like origins/constraints; finality is reserved
 * for host lock-in. Stored as a London wall-clock string in rooms.settings
 * (jsonb ||-merge / `- 'eventAt'` so it can't clobber settings.decided), with a
 * settings_updated room event. After it commits, fires a best-effort auto-replan
 * (maybeAutoReplan) so a complete plan re-costs against the new time — but never
 * on a decided room (guard 0), so a background action can't undo a host's pick.
 */
export async function setEventTime(
  sessionToken: string,
  roomId: string,
  eventAt: string | null
): Promise<SetEventTimeResult> {
  const { participant } = await requireMember(sessionToken, roomId)

  if (eventAt !== null) {
    if (typeof eventAt !== "string" || !EVENT_AT_RE.test(eventAt)) {
      return { ok: false, error: "Pick a valid date and time." }
    }
    // Parse as UTC only to bounds-check — the stored value stays wall-clock.
    const t = Date.parse(`${eventAt}:00Z`)
    if (Number.isNaN(t)) {
      return { ok: false, error: "Pick a valid date and time." }
    }
    if (t <= Date.now()) {
      return { ok: false, error: "Pick a time in the future." }
    }
    if (t - Date.now() > MAX_HORIZON_MS) {
      return { ok: false, error: "Pick a time within the next 60 days." }
    }
  }

  await withRoomRevision({
    roomId,
    eventType: "settings_updated",
    actorParticipantId: participant.id,
    payload: { eventAt },
    // Same transaction as the revision bump + event insert. jsonb merge (not a
    // whole-object overwrite) so a concurrent settings.decided write survives.
    write: async (tx) => {
      await tx
        .update(rooms)
        .set({
          settings:
            eventAt === null
              ? sql`${rooms.settings} - 'eventAt'`
              : sql`${rooms.settings} || ${JSON.stringify({ eventAt })}::jsonb`,
        })
        .where(eq(rooms.id, roomId))
    },
  })

  // Nudge every tab to update its event-time chip (ADR 0014 full payload).
  // Fired after commit and best-effort — a realtime hiccup must not fail the
  // write.
  try {
    await broadcastRoomEvent(roomId, { type: "settings:update", eventAt })
  } catch (err) {
    console.warn("setEventTime: broadcast settings:update failed", err)
  }

  // Fire-and-forget: re-cost the existing plan against the new time. Guarded
  // (decided rooms skipped, cooldown, complete-plan-exists) inside the helper;
  // any failure is swallowed there so it can never surface to this caller.
  void maybeAutoReplan(roomId, participant.id)

  return { ok: true }
}
