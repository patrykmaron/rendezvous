# 0021. Auto re-plan the room when its inputs change after a plan exists

**Status:** Accepted
**Date:** 2026-07-22

## Context

The room agent (ADR 0011, 0015) runs only on an explicit `@agent` mention or the "Find fair spots" button. Once a plan exists, though, the group keeps talking: someone says "actually I'm vegetarian" (recorded as a constraint by the background extractor, ADR 0019) or the host changes the event time. Nothing re-ran the agent, so the plan silently went stale and the app stopped feeling like it was "still thinking". We want the agent to rethink automatically when a durable input changes — without a new always-on service, without looping on itself, and without ever surprising a group that has already locked in a venue.

We already have the pieces: background constraint extraction (ADR 0019), the durable revision/event log (ADR 0007), the room-agent orchestrator triggered task-to-task, and ephemeral Liveblocks nudges (ADR 0012). The two inputs that can change post-plan are **constraints** (a background Trigger.dev task) and the **event time** (a web server action) — two different execution contexts that must not diverge in behaviour.

## Decision

We will auto-replan on any net input change after a completed plan, from **exactly one trigger point per input**, both gated by the **same guard predicate**.

- **Constraint changes → tasks side.** `extract-constraints`, after its durable writes, calls `maybeStartAutoReplan` (`packages/tasks/src/lib/start-analysis.ts`) whenever it durably changed constraints (`added + removed > 0`), wrapped in try/catch so a replan failure can never affect extraction's result. **Retractions replan too** — removing "vegetarian" changes venue selection as much as adding it.
- **Event-time changes → web side.** `setEventTime` calls the twin `maybeAutoReplan` (`apps/web/lib/agent-trigger.ts`) fire-and-forget after the write commits.
- **One shared guard predicate**, evaluated in order, each failure a silent logged skip (no chat nagging from a background path):
  0. **room is not `decided`** — a background input change must never blow away a host's lock-in; the host re-runs manually (which clears the decision) to change a decided plan. This is load-bearing: it makes a decided room unreachable, so the auto-replan path needs **no** decision-clearing branch (unlike the manual `startAnalysis`).
  1. **a `complete` plan already exists** — auto-replan refines a plan, it never creates the first one (pre-plan constraints feed the manual run).
  2. **no run already in flight** (newest-overall snapshot isn't `running`/`pending`; a `failed` newest is also left alone so a config error can't re-fire on every message).
  3. **≥ 2 origins.**
  4. **30s cooldown** — no `analysis_requested` room event in the last 30 seconds, bounding the rate so a chatty burst can't fan out a run per message.
- **`source` marker rides run metadata.** The run is tagged `source` = `"auto_constraints"` / `"auto_event_time"` via trigger-time run metadata (the only channel `useRoomAgent` reads — it skips the payload column) and, on the constraint path, also via the room-agent payload, which the run re-emits with `metadata.set("source", …)`. The client derives the "Rethinking with new preferences…" / "Updating for the new time…" badge from it and keeps the retained plan on screen during the re-run (ADR 0022).
- **Twin, not shared code.** The tasks-side `maybeStartAutoReplan` and web-side `maybeAutoReplan`/`startAnalysis` are documented twins (like the `liveblocks.ts` broadcast twins), kept in sync by cross-reference comments. Sharing them is not viable: the web helper is `import "server-only"` and pulls in web's Liveblocks global augmentation, which conflicts with the task-side one — the same reason `room-agent.types.ts` exists.

**Loop-safety invariant chain** (verified against the code; the reason this can never recurse):

1. Extraction is triggered **only** by `sendMessage`, which inserts only `role:"user"` rows. The agent's `postAssistantMessage` and web's `postSystemMessage` insert assistant/system rows directly and never queue extraction → assistant/system messages can never cause extraction.
2. Auto-replan is triggered **only** by the two hooks above, only on a net change, at most once per run (single call site; `maxAttempts:1`), behind the guards.
3. A room-agent run writes assistant messages, `plan_snapshots`, and room events — it **never** writes `constraints`. So a replan changes no constraints → cannot cause extraction → cannot cause another replan. The chain terminates in one hop; the cooldown + in-flight guard bound even an adversarial message flood to ~1 run per run-duration.

Alternatives considered: replanning inside the extraction write path synchronously (rejected — couples an LLM funnel to constraint writes); skipping retraction-only changes (rejected — "I eat meat now, why still vegan places?" reads as broken); a debounce/`concurrencyKey` on `room-agent` to make it idempotent (deferred — the cooldown covers the common races; a genuine follow-up, out of scope here).

## Consequences

- The agent visibly keeps thinking: a post-plan preference or time change produces a fresh plan within seconds, tied to the user's words by the badge.
- Cost is bounded by the guards: only after a complete plan, ≥ 30s apart, effectively ≤ 1 full funnel (TfL + OpenAI) per run-duration per room. The 30s cooldown is the single tuning knob.
- Decided rooms are protected — guard 0 is the only thing standing between a background chat message and a host's locked-in venue, so it must never be removed from either twin.
- Residual accepted race: a header-button click in the sub-second window between the cooldown query and the event insert can start two concurrent runs. Both complete; the last `finalize-plan` wins; wasteful, not incorrect (this class of double-run already exists via double-click). Follow-up: a `concurrencyKey`/debounce on `room-agent`.
- Twin-drift risk: the guard predicate now lives in two files. Cross-reference comments and a shared 30s constant name flag it, but a change to one must be mirrored to the other.
