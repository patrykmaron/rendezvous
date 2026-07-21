import { streams } from "@trigger.dev/sdk"

// Realtime stream of the agent's assistant-token deltas. The `room-agent` task
// appends one chunk per Responses-API `response.output_text.delta`; the web
// room subscribes to this stream by run id to render the agent "typing" its
// reply live (ADR 0012 — ephemeral, not the durable message). String parts.
// The explicit `ReturnType<...>` annotation avoids TS2742 (the inferred
// `RealtimeDefinedStream` type lives in @trigger.dev/core, which is only a
// transitive dep here so cannot be named directly); referencing the
// SDK-exported `streams.define` keeps the emitted type portable.
export const agentStream: ReturnType<typeof streams.define<string>> =
  streams.define<string>({ id: "agent" })
