import type { Task } from "@trigger.dev/sdk"

// Dependency-light type surface for the `extract-constraints` task, safe to
// `import type` from the Next web app (see agent-trigger.ts). Importing
// `typeof extractConstraintsTask` directly would drag the whole task module
// graph (openai, @workspace/db, the task-side Liveblocks broadcaster) into
// web's tsc pass, where web's global `Liveblocks` augmentation then conflicts
// with the task-side one. So, like room-agent.types.ts, this MIRRORS the task's
// payload/output. SOURCE OF TRUTH: ./extract-constraints.ts — keep in sync.

export type ExtractConstraintsPayload = {
  roomId: string
  messageId: string
  participantId: string
  content: string
}

export type ExtractConstraintsOutput = {
  added: number
  removed: number
  skipped: number
}

/**
 * The `extract-constraints` task's type, for
 * `tasks.trigger<ExtractConstraintsTask>` from server code without importing
 * the task implementation.
 */
export type ExtractConstraintsTask = Task<
  "extract-constraints",
  ExtractConstraintsPayload,
  ExtractConstraintsOutput
>
