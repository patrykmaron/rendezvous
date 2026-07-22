# 0019. Extract planning constraints from every chat message in the background

**Status:** Accepted
**Date:** 2026-07-22

## Context

The room agent already reads the `constraints` table into its planning prompt, but nothing ever wrote to it: constraints ("I'm vegetarian", "no stairs", "under £20 each") lived only as prose buried in chat history, invisible to the group and only loosely honoured by the agent. We want the app to feel like it is _always listening_ — surfacing what it heard as durable, glanceable state — without adding a form for people to fill in, and without a second always-on service.

Constraints are low-volume, per-message, and non-urgent; they must never slow down or fail a chat send. We already run background work on Trigger.dev (ADR 0011), write durable room state through the revision/event log (ADR 0007), and push ephemeral "go look again" nudges over Liveblocks (ADR 0012). The chat message itself is untrusted user input.

## Decision

We will extract constraints in the background, one Trigger.dev task per qualifying message.

- **Fire-and-forget from `sendMessage`.** After the durable insert and `message:new` broadcast, `sendMessage` triggers the `extract-constraints` task (skipping trivially short messages — under 8 chars once any `@agent` mention is stripped). The trigger is wrapped in try/catch and awaits nothing meaningful: a Trigger outage leaves the send instant and unaffected.
- **One strict-schema OpenAI Responses call.** The task makes a single non-streaming call (`reasoning.effort: "low"`, `max_output_tokens: 500`, a cheap `EXTRACTOR_MODEL` kept separate from the planning `AGENT_MODEL`) with a strict `json_schema` format returning `{ constraints: [{ action, kind, scope, isHard, summary, normalized }] }`. Output is re-validated with zod (the real enforcement layer — the strict format falls back to `strict:false` if a gateway rejects the shape), then clamped (summary ≤ 40 chars, normalized to a lowercase key, ≤ 4 items, deduped by `(kind, scope, normalized)`).
- **Per-room serialization instead of a DB unique constraint.** The task runs on a dedicated queue with `concurrencyLimit: 1` and is triggered with `concurrencyKey: roomId`, so at most one extractor runs per room at a time. That makes the check-then-insert dedupe (skip if a matching `normalized` row already exists for the target) race-free without adding a unique index to the flexible jsonb payload. `maxAttempts: 1` (a retry would risk double-writing), `machine: "micro"`.
- **Durable writes via `withRoomRevision`.** Each add/remove bumps the room revision and appends a `constraint_added` / `constraint_removed` event in the same transaction (ADR 0007; both event types already existed in the schema). Personal constraints attach to the speaker; a `scope: "group"` constraint is written room-wide (null participant). A retract deletes the speaker's matching rows (by normalized key, falling back to all rows of that kind). Each participant is capped at 10 constraints.
- **Full-payload `constraint:update` broadcasts.** After commit the task best-effort broadcasts a `constraint:update` nudge carrying the whole `ConstraintView`, so chips appear/disappear live. The chip strip also patches author name/colour off `member:update`. Deletion (chip X button → `removeConstraint` server action, own or room-wide only) is likewise broadcast-driven, with no optimistic local removal — mirroring how reactions work.

Alternatives considered: extracting inside the existing `room-agent` run (rejected — that only runs on explicit `@agent`, so constraints would go unrecorded the rest of the time); a synchronous extraction in `sendMessage` (rejected — puts an LLM call on the send path); a structured `/constraint` command or form (rejected — defeats the "always listening" feel that is the whole point).

## Consequences

- The group sees what the app heard as live chips, and the planning agent's prompt is now backed by real, deduped constraint rows with human summaries and authors.
- Injection posture: the message is untrusted and the extractor has **no tools** — it only emits schema-shaped data. The instructions tell it never to follow instructions in the message, and zod + the clamps are a hard backstop, so a prompt-injection attempt can at worst create a (capped, deletable) constraint chip.
- Extra cost: one cheap LLM call per non-trivial message. Acceptable at chat volumes; `EXTRACTOR_MODEL` is isolated so it can be pointed at a cheaper model later.
- The dedupe/cap correctness depends on the per-room `concurrencyKey` — if a future caller triggers the task without it, concurrent extractors in one room could double-write. This is documented at the trigger site and the queue.
- `constraints.payload` now carries a `{ summary, normalized, sourceMessageId }` shape by convention (not enforced by the schema); readers fall back to `kind` when `summary` is absent, so legacy rows still render.
