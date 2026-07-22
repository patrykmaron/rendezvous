import type { Task } from "@trigger.dev/sdk"

// Dependency-light type surface for the `room-agent` task, safe to `import
// type` from the Next web app. Importing `typeof roomAgentTask` directly would
// drag the whole task module graph (openai, @workspace/db, the task-side
// Liveblocks broadcaster) into web's tsc pass — where web's global `Liveblocks`
// augmentation then conflicts with the task-side one. So, like the deliberate
// TaskRoomEvent duplication in ../lib/liveblocks.ts, this MIRRORS the task's
// payload/output. SOURCE OF TRUTH: ./room-agent.ts (roomAgentPayload + run's
// return union) — keep in sync.

export type RoomAgentPayload = {
  roomId: string
  analysisId: string
  triggerMessageId?: string
  participantId: string
  // WHY this run exists (e.g. "auto_constraints", "auto_event_time"). Optional:
  // the manual @agent/button path omits it, and the web `startAnalysis`
  // event-time path passes it only as trigger-time run metadata. The auto-replan
  // twin (lib/start-analysis.ts) passes it here too so the run re-emits it via
  // `metadata.set("source", …)` for the client's "Updating…" badge.
  source?: string
}

export type RoomAgentOutput =
  | { kind: "config_error" }
  | { kind: "needs_origins" }
  | { kind: "ok"; candidates: number }
  | { kind: "failed"; reason: string }

/**
 * The `room-agent` task's type, for `tasks.trigger<RoomAgentTask>` (server) and
 * `useRealtimeRunsWithTag<RoomAgentTask>` (client) — without importing the task
 * implementation.
 */
export type RoomAgentTask = Task<"room-agent", RoomAgentPayload, RoomAgentOutput>
