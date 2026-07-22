import { desc, eq, getDb } from "@workspace/db/postgres"
import {
  constraints as constraintsTable,
  messages,
  participantOrigins,
  participants,
  roomMembers,
  rooms,
} from "@workspace/db/schema"
import { withRoomRevision } from "@workspace/db/revision"
import { logger, metadata, schemaTask } from "@trigger.dev/sdk"
import OpenAI from "openai"
import type {
  Response as OpenAIResponse,
  ResponseFunctionToolCall,
  ResponseInputItem,
  Tool,
} from "openai/resources/responses/responses"
import { z } from "zod"

import { broadcastRoomEvent } from "../lib/liveblocks"
import { generateCandidatesTask } from "./analysis/generate-candidates"
import { getVenuesTask, type Venue } from "./analysis/get-venues"
import { finalizePlanTask, markPlanFailed } from "./analysis/finalize-plan"
import { journeyDetailsTask } from "./analysis/journey-details"
import { routeMatrixTask } from "./analysis/route-matrix"
import { scoreCandidatesTask } from "./analysis/score-candidates"
import { capJourneyPoints } from "./analysis/travel"
import type {
  AnalysisOrigin,
  Candidate,
  PlanJourney,
  PlanResult,
} from "./analysis/types"
import { AGENT_MODEL } from "./agent/model"
import { agentStream } from "./streams"

// The Rendezvous persona shown next to durable assistant messages (matches the
// web chat's assistant identity — apps/web resolves null-author rows to this).
const AGENT_NAME = "Rendezvous"
const AGENT_COLOR = "#7C3AED"

// A ranked finalist as returned by `ch-score-candidates` (structural mirror of
// its un-exported RankedCandidate; kept local so this task need not import it).
type RankedCandidate = {
  h3: string
  name: string
  rank: number
  overallScore: number
  fairnessScore: number
  avgMinutes: number
  maxMinutes: number
  participantCount: number
  perParticipant: { participantId: string; minutes: number }[]
}

// Everything the tool executors accumulate across the loop. The analysis-phase
// ClickHouse tasks are NOT idempotent per-call, so each cached field also acts
// as an at-most-once guard: a repeated model tool call returns the cache.
type AgentState = {
  generate?: unknown
  candidates?: Candidate[]
  routeMatrix?: unknown
  rank?: unknown
  ranked?: RankedCandidate[]
  venues?: unknown
  venuesByCell?: Map<string, Venue[]>
  // Exact door-to-door journeys keyed h3 → participantId → journey, fetched in
  // the deterministic finish path and merged into each candidate row.
  journeys?: Map<string, Map<string, PlanJourney>>
  // Set when an analysis tool (generate_candidates / compute_route_matrix /
  // rank_candidates) returns a semantic "no results" outcome. The system
  // prompt tells the model to post its own apologetic send_chat and stop
  // when this happens; semanticFailureNarrated then records whether that
  // actually happened, so the deterministic finish path can skip
  // failGracefully's own apology and avoid a double apology.
  semanticFailure?: "no_candidates" | "no_routes" | "no_scores"
  semanticFailureNarrated?: boolean
}

// --- Map overlay (field-for-field mirror of apps/web/lib/types.ts MapOverlay;
// a package must not import an app, so the shape is duplicated. The web line
// layer reads `properties.color` per feature and GeoJSON [lng,lat] order). ---
type OverlayPin = {
  id: string
  lat: number
  lng: number
  kind: "candidate" | "venue"
  rank?: number
  label?: string
  // Foursquare place id (venue pins only) — lets the client enrich the pin
  // with a Google Places preview (ADR 0018). Optional so older persisted
  // snapshots and model-painted pins (show_map's strict schema has no
  // placeId field) still parse.
  placeId?: string
  // Google Places id (venue pins only) — when present the preview route can
  // GET the place directly (cheaper, exact) instead of Text Search (ADR 0020).
  googlePlaceId?: string
}
type OverlayRoutes = {
  type: "FeatureCollection"
  features: Array<{
    type: "Feature"
    geometry: { type: "LineString"; coordinates: [number, number][] }
    // `mode` is additive (web MapOverlay.routes is a generic FeatureCollection);
    // it drives the walking-dash line layer. Absent on straight-line fallbacks.
    properties: { color: string; mode?: string }
  }>
}
type MapOverlay = {
  pins: OverlayPin[]
  routes: OverlayRoutes | null
  focus: { lat: number; lng: number; zoom?: number } | null
}

const roomAgentPayload = z.object({
  roomId: z.uuid(),
  analysisId: z.uuid(),
  triggerMessageId: z.uuid().optional(),
  participantId: z.uuid(),
})

// ---------------------------------------------------------------------------
// Tool schemas (OpenAI Responses "function" tools). strict:true ⇒ every schema
// sets additionalProperties:false, lists EVERY property in `required`, and
// types optionals as ["…","null"] unions (the model must emit the key, null
// when unused). Executors live in the task body (they close over run state).
// ---------------------------------------------------------------------------
const emptyParams = {
  type: "object",
  additionalProperties: false,
  properties: {},
  required: [],
} as const

const TOOLS: Tool[] = [
  {
    type: "function",
    name: "generate_candidates",
    description:
      "Generate candidate meeting areas from every member's start point. Call first, with no arguments.",
    strict: true,
    parameters: emptyParams,
  },
  {
    type: "function",
    name: "compute_route_matrix",
    description:
      "Compute each member's journey time to every candidate area via TfL. Call after generate_candidates. May return {kind:'no_routes'} when routing is unavailable.",
    strict: true,
    parameters: emptyParams,
  },
  {
    type: "function",
    name: "rank_candidates",
    description:
      "Rank the candidate areas for fairness and speed. Call after compute_route_matrix. May return {kind:'no_scores'}.",
    strict: true,
    parameters: emptyParams,
  },
  {
    type: "function",
    name: "fetch_venues",
    description:
      "Fetch representative venues for the top-ranked areas. Call after rank_candidates.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["h3_cells", "categories"],
      properties: {
        h3_cells: {
          type: "array",
          description: "H3 cell ids of the areas to fetch venues for.",
          items: { type: "string" },
        },
        categories: {
          type: ["array", "null"],
          description:
            'Free-text venue keywords, matched case-insensitively as substrings against Foursquare taxonomy labels (e.g. "steakhouse", "cocktail bar", "vegan", "coffee", "live music"). Derive them from the room\'s constraints/chat when the group expressed a venue preference; pass null for a general mix.',
          items: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    name: "send_chat",
    description:
      "Post one short (max 2 sentences) chat message to the group from Rendezvous.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: { type: "string", description: "The message text." },
      },
    },
  },
  {
    type: "function",
    name: "show_map",
    description:
      "Paint pins (and optionally routes/focus) onto the shared map. This is how the group sees results — always use it to reveal areas and venues.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pins", "draw_routes_to", "focus_pin"],
      properties: {
        pins: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "lat", "lng", "kind", "rank", "label"],
            properties: {
              id: { type: "string" },
              lat: { type: "number" },
              lng: { type: "number" },
              kind: { type: "string", enum: ["candidate", "venue"] },
              rank: { type: ["number", "null"] },
              label: { type: ["string", "null"] },
            },
          },
        },
        draw_routes_to: {
          type: ["string", "null"],
          description:
            "A pin id to draw everyone's routes to, or null for no routes.",
        },
        focus_pin: {
          type: ["string", "null"],
          description: "A pin id to centre the map on, or null.",
        },
      },
    },
  },
]

// ---------------------------------------------------------------------------
// System prompt. The base persona/rules are constant; members, origins,
// constraints and the triggering message are appended as run context.
// ---------------------------------------------------------------------------
const BASE_INSTRUCTIONS = `You are ${AGENT_NAME}, the planning agent for a group deciding where to meet up in London. You work inside the group's live chat, beside a shared map.

Your answers are VISUAL. Guide the group with the map and short chat messages — never long text.

Rules:
- Every chat message is at most 2 sentences.
- Never paste tables, or lists of numbers, times, or scores into the chat — put results on the map instead.
- Always reveal results by calling show_map; the chat is only a short, friendly summary.
- Respect "must" constraints when choosing venues; treat "nice-to-have" as preferences.
- Venues in tool results carry \`verified\`/\`rating\` — prefer verified venues, and you may mention a standout rating (e.g. 4.6★) in your summary.

Workflow — call the tools in this order:
1. generate_candidates — find candidate meeting areas from everyone's start points.
2. compute_route_matrix — get everyone's journey times to those areas.
3. rank_candidates — rank the areas for fairness and speed.
4. fetch_venues — get venues for the top-ranked areas; pass category keywords when the group expressed venue preferences (e.g. steak → "steakhouse").
5. show_map — drop pins for the top 3 areas (kind "candidate", with rank) plus the venues (kind "venue") for the winner, optionally draw routes to and focus the winner, so the group can see the plan.
6. send_chat — one short, friendly summary of your recommendation.

TfL journey routing may be unavailable. If compute_route_matrix returns {kind:"no_routes"}, or rank_candidates returns {kind:"no_scores"} or no results, do NOT invent journey times: send one short, apologetic chat message explaining you couldn't work out journeys right now, and stop.`

type LoadedContext = {
  room: { name: string; currentRevision: number }
  /** London wall-clock "yyyy-MM-ddTHH:mm" target time, or null when unset. */
  eventAt: string | null
  origins: Array<{
    participantId: string
    name: string
    color: string
    lat: number
    lng: number
    label: string | null
    transportModes: string[]
    requiresStepFree: boolean
  }>
  members: Array<{ name: string; color: string }>
  constraints: Array<{
    kind: string
    isHard: boolean
    payload: unknown
    participantId: string | null
    authorName: string | null
  }>
  history: Array<{ role: string; content: string; authorName: string | null }>
  triggerMessage: { content: string; authorName: string | null } | null
}

async function loadContext(
  roomId: string,
  triggerMessageId: string | undefined
): Promise<LoadedContext> {
  const db = getDb()

  const [room] = await db
    .select({
      name: rooms.name,
      currentRevision: rooms.currentRevision,
      settings: rooms.settings,
    })
    .from(rooms)
    .where(eq(rooms.id, roomId))
  if (!room) throw new Error(`room-agent: room not found: ${roomId}`)

  // rooms.settings is jsonb; guard the runtime value even though it is typed.
  const eventAt =
    typeof room.settings?.eventAt === "string" ? room.settings.eventAt : null

  const members = await db
    .select({ name: participants.displayName, color: participants.color })
    .from(roomMembers)
    .innerJoin(participants, eq(roomMembers.participantId, participants.id))
    .where(eq(roomMembers.roomId, roomId))

  const origins = await db
    .select({
      participantId: participantOrigins.participantId,
      name: participants.displayName,
      color: participants.color,
      lat: participantOrigins.latitude,
      lng: participantOrigins.longitude,
      label: participantOrigins.label,
      transportModes: participantOrigins.transportModes,
      requiresStepFree: participantOrigins.requiresStepFree,
    })
    .from(participantOrigins)
    .innerJoin(
      participants,
      eq(participantOrigins.participantId, participants.id)
    )
    .where(eq(participantOrigins.roomId, roomId))

  const constraints = await db
    .select({
      kind: constraintsTable.kind,
      isHard: constraintsTable.isHard,
      payload: constraintsTable.payload,
      participantId: constraintsTable.participantId,
      authorName: participants.displayName,
    })
    .from(constraintsTable)
    .leftJoin(participants, eq(constraintsTable.participantId, participants.id))
    .where(eq(constraintsTable.roomId, roomId))

  const recent = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      authorName: participants.displayName,
    })
    .from(messages)
    .leftJoin(participants, eq(messages.participantId, participants.id))
    .where(eq(messages.roomId, roomId))
    .orderBy(desc(messages.createdAt))
    .limit(30)

  // Oldest → newest for the model.
  const ordered = recent.slice().reverse()
  const history = ordered.map((m) => ({
    role: m.role,
    content: m.content,
    authorName: m.authorName,
  }))

  let triggerMessage: LoadedContext["triggerMessage"] = null
  if (triggerMessageId) {
    const hit = recent.find((m) => m.id === triggerMessageId)
    if (hit)
      triggerMessage = { content: hit.content, authorName: hit.authorName }
  }
  if (!triggerMessage) {
    const lastUser = ordered.filter((m) => m.role === "user").at(-1)
    if (lastUser)
      triggerMessage = {
        content: lastUser.content,
        authorName: lastUser.authorName,
      }
  }

  return {
    room,
    eventAt,
    origins,
    members,
    constraints,
    history,
    triggerMessage,
  }
}

function buildInstructions(ctx: LoadedContext): string {
  const memberList = ctx.members.map((m) => m.name).join(", ") || "(none yet)"
  const originList =
    ctx.origins
      .map(
        (o) =>
          `${o.name} from ${o.lat.toFixed(4)},${o.lng.toFixed(4)}${o.label ? ` (${o.label})` : ""}${o.requiresStepFree ? " (step-free)" : ""}`
      )
      .join("; ") || "(none)"
  const constraintList =
    ctx.constraints
      .map((c) => {
        // Prefer the extractor's human `summary` (ADR 0019); older rows without
        // one fall back to the raw payload JSON.
        const summary =
          c.payload &&
          typeof c.payload === "object" &&
          typeof (c.payload as Record<string, unknown>).summary === "string"
            ? ((c.payload as Record<string, unknown>).summary as string)
            : JSON.stringify(c.payload)
        return `${c.kind}${c.isHard ? " (must)" : " (nice-to-have)"} — ${summary} [${c.authorName ?? "whole group"}]`
      })
      .join("; ") || "None"
  const trigger = ctx.triggerMessage
    ? `"${ctx.triggerMessage.content}"${ctx.triggerMessage.authorName ? ` — from ${ctx.triggerMessage.authorName}` : ""}`
    : "(none)"

  return `${BASE_INSTRUCTIONS}

--- Context ---
Group: ${ctx.room.name}
Members: ${memberList}
Start points: ${originList}
Event time: ${ctx.eventAt ?? "not set"}
Constraints: ${constraintList}
Triggering message: ${trigger}`
}

function buildHistoryInput(ctx: LoadedContext): ResponseInputItem[] {
  const items: ResponseInputItem[] = ctx.history.map((m) => {
    const role: "user" | "assistant" | "system" =
      m.role === "assistant" || m.role === "system" ? m.role : "user"
    const content =
      role === "user" && m.authorName
        ? `${m.authorName}: ${m.content}`
        : m.content
    return { role, content }
  })
  if (items.length === 0) {
    items.push({
      role: "user",
      content: "Help us find a fair place in London to meet up.",
    })
  }
  return items
}

// ---------------------------------------------------------------------------
// One streamed Responses-API turn. Appends every text delta to the realtime
// agent stream; returns the full response object from `response.completed`.
// ---------------------------------------------------------------------------
async function streamTurn(
  openai: OpenAI,
  args: {
    instructions: string
    input: ResponseInputItem[]
    previousResponseId?: string
  }
): Promise<OpenAIResponse> {
  const stream = await openai.responses.create({
    model: AGENT_MODEL,
    instructions: args.instructions,
    input: args.input,
    ...(args.previousResponseId
      ? { previous_response_id: args.previousResponseId }
      : {}),
    tools: TOOLS,
    reasoning: { effort: "low" },
    text: { verbosity: "low" },
    max_output_tokens: 2048,
    stream: true,
  })

  let final: OpenAIResponse | undefined
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      await agentStream.append(event.delta)
    } else if (event.type === "response.completed") {
      final = event.response
    }
  }
  if (!final) {
    throw new Error("OpenAI stream ended without a response.completed event")
  }
  return final
}

// Status phases surfaced to the UI (metadata.status.phase). routesTotal /
// routesDone additionally flow up from the route-matrix children via
// metadata.root.
type Phase =
  | "planning"
  | "candidates"
  | "routing"
  | "scoring"
  | "venues"
  | "summarizing"
  | "done"
  | "error"
  | "waiting_input"

function setStatus(phase: Phase, label: string): void {
  metadata.set("status", { phase, label })
  metadata.append("timeline", { at: new Date().toISOString(), label })
}

const MAX_STEPS = 12

/**
 * Room orchestrator (WS8). Runs an OpenAI Responses tool loop that drives the
 * ClickHouse analysis funnel (Task 7) as tools, streams status + tokens to the
 * UI via Trigger metadata/streams, and posts short chat messages. The plan
 * itself is assembled DETERMINISTICALLY from tool outputs — the model's numbers
 * are never trusted.
 *
 * maxAttempts:1 — a retry would double-post chat messages. Failures are caught
 * and narrated (markPlanFailed + apologetic chat + status:error), never
 * rethrown.
 */
export const roomAgentTask = schemaTask({
  id: "room-agent",
  schema: roomAgentPayload,
  retry: { maxAttempts: 1 },
  maxDuration: 900,
  run: async ({ roomId, analysisId, triggerMessageId, participantId }) => {
    void participantId // triggering actor; reserved for future attribution.

    // Durable assistant message + live nudge. Bumps the room revision and
    // appends a message_sent event in one transaction (ADR 0007).
    async function postAssistantMessage(text: string): Promise<void> {
      const { result } = await withRoomRevision({
        roomId,
        eventType: "message_sent",
        write: async (tx) => {
          const [row] = await tx
            .insert(messages)
            .values({
              roomId,
              participantId: null,
              role: "assistant",
              content: text,
            })
            .returning({ id: messages.id, createdAt: messages.createdAt })
          return row
        },
      })
      if (result) {
        // The broadcast is an ephemeral nudge (ADR 0012) — the durable message
        // row above is the source of truth. A broadcast failure (e.g. no
        // Liveblocks room yet, transient) must never abort planning, so it is
        // swallowed here rather than propagating out of send_chat.
        try {
          await broadcastRoomEvent(roomId, {
            type: "message:new",
            message: {
              id: result.id,
              roomId,
              participantId: null,
              role: "assistant",
              content: text,
              createdAt: result.createdAt.toISOString(),
              author: { name: AGENT_NAME, color: AGENT_COLOR },
              // Chat clients read message.reactions unconditionally; a new
              // assistant message has none yet.
              reactions: [],
            },
          })
        } catch (e) {
          logger.warn("message:new broadcast failed (non-fatal)", {
            error: String(e),
          })
        }
      }
    }

    // Terminal failure narrative — never rethrows. opts.skipChat lets a
    // caller suppress the apology when the model already narrated this same
    // failure via its own send_chat tool call (see semanticFailureNarrated);
    // markPlanFailed + status:error still always run.
    async function failGracefully(
      chatText: string,
      reason: string,
      opts?: { skipChat?: boolean }
    ): Promise<{ kind: "failed"; reason: string }> {
      setStatus("error", "Something went wrong")
      if (!opts?.skipChat) {
        try {
          await postAssistantMessage(chatText)
        } catch (e) {
          logger.error("failGracefully: send_chat failed", {
            error: String(e),
          })
        }
      }
      try {
        await markPlanFailed(analysisId, roomId, reason)
      } catch (e) {
        logger.error("failGracefully: markPlanFailed failed", {
          error: String(e),
        })
      }
      return { kind: "failed", reason }
    }

    // 0. OPENAI_KEY guard — cannot run the agent without it.
    if (!process.env.OPENAI_KEY) {
      logger.error("OPENAI_KEY is not set")
      await failGracefully(
        "I can't plan a meetup right now due to a configuration issue — please try again later.",
        "OPENAI_KEY not set"
      )
      return { kind: "config_error" as const }
    }

    // 1-2. Load room context and check origins INSIDE a guard, so any pre-loop
    // failure (e.g. loadContext throwing on a missing room, or an invalid
    // triggerMessageId) is narrated via failGracefully instead of escaping as
    // an uncaught run failure that leaves the snapshot stuck "running". The
    // needs_origins branch is NOT an error: it returns normally from inside the
    // guard (status waiting_input, not error), exactly as before.
    let ctx: LoadedContext
    let roomRevision: number
    try {
      ctx = await loadContext(roomId, triggerMessageId)
      roomRevision = ctx.room.currentRevision

      if (ctx.origins.length < 2) {
        setStatus("waiting_input", "Waiting for start points")
        await postAssistantMessage(
          "I need at least two people to share where they're setting off from before I can plan — please drop your start points on the map!"
        )
        // markPlanFailed's own broadcast is isolated so a Liveblocks hiccup
        // can't turn this into a thrown run.
        try {
          await markPlanFailed(
            analysisId,
            roomId,
            "Fewer than two participant origins"
          )
        } catch (e) {
          logger.warn("markPlanFailed broadcast failed (non-fatal)", {
            error: String(e),
          })
        }
        return { kind: "needs_origins" as const }
      }
    } catch (err) {
      logger.error("room-agent load failed", { error: String(err) })
      return await failGracefully(
        "Sorry, something went wrong while planning your meetup — please try again.",
        err instanceof Error ? err.message : "unknown error"
      )
    }

    const origins: AnalysisOrigin[] = ctx.origins.map((o) => ({
      participantId: o.participantId,
      name: o.name,
      color: o.color,
      lat: o.lat,
      lng: o.lng,
      transportModes: o.transportModes,
      requiresStepFree: o.requiresStepFree,
    }))
    const participantById = new Map(
      ctx.origins.map((o) => [
        o.participantId,
        { name: o.name, color: o.color, lat: o.lat, lng: o.lng },
      ])
    )

    const state: AgentState = {}
    const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY })

    // --- Tool executors (close over run state). Each returns a JSON-
    // serialisable value that becomes the function_call_output string. ---

    function parseArgs(raw: string): Record<string, unknown> {
      try {
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      } catch {
        return {}
      }
    }

    async function execGenerateCandidates(): Promise<unknown> {
      setStatus("candidates", "Scanning candidate areas…")
      if (state.generate !== undefined) return state.generate
      const res = await generateCandidatesTask.triggerAndWait({
        analysisId,
        roomId,
        roomRevision,
        origins,
      })
      if (!res.ok) {
        state.generate = { error: "task_failed" }
        return state.generate
      }
      if (res.output.kind === "ok") state.candidates = res.output.candidates
      else if (res.output.kind === "no_candidates")
        state.semanticFailure = "no_candidates"
      state.generate = res.output
      return res.output
    }

    async function execComputeRouteMatrix(): Promise<unknown> {
      if (!state.candidates || state.candidates.length === 0) {
        return { error: "no_candidates_yet" }
      }
      const n = origins.length * state.candidates.length
      setStatus("routing", `Computing ${n} journeys…`)
      if (state.routeMatrix !== undefined) return state.routeMatrix
      const res = await routeMatrixTask.triggerAndWait({
        analysisId,
        roomId,
        roomRevision,
        origins,
        candidates: state.candidates,
        ...(ctx.eventAt ? { eventAt: ctx.eventAt } : {}),
      })
      if (!res.ok) {
        state.routeMatrix = { error: "task_failed" }
        return state.routeMatrix
      }
      if (res.output.kind === "no_routes") state.semanticFailure = "no_routes"
      state.routeMatrix = res.output
      return state.routeMatrix
    }

    async function execRankCandidates(): Promise<unknown> {
      setStatus("scoring", "Ranking areas for fairness…")
      if (state.rank !== undefined) return state.rank
      const res = await scoreCandidatesTask.triggerAndWait({
        analysisId,
        roomId,
        roomRevision,
        expectedParticipants: origins.length,
      })
      if (!res.ok) {
        state.rank = { error: "task_failed" }
        return state.rank
      }
      if (res.output.kind === "ok") state.ranked = res.output.ranked
      else if (res.output.kind === "no_scores")
        state.semanticFailure = "no_scores"
      state.rank = res.output
      return res.output
    }

    async function execFetchVenues(
      args: Record<string, unknown>
    ): Promise<unknown> {
      if (!state.ranked || state.ranked.length === 0) {
        return { error: "no_ranking_yet" }
      }
      setStatus("venues", "Finding venues…")
      if (state.venues !== undefined) return state.venues
      // Always the finalists from state (top 3), regardless of the model's arg.
      const h3Cells = state.ranked.slice(0, 3).map((r) => r.h3)
      const rawCats = args.categories
      const categories =
        Array.isArray(rawCats) && rawCats.length > 0
          ? rawCats.filter((c): c is string => typeof c === "string")
          : undefined
      const res = await getVenuesTask.triggerAndWait({
        h3Cells,
        ...(categories ? { categories } : {}),
      })
      if (!res.ok) {
        state.venues = { error: "task_failed" }
        return state.venues
      }
      const byCell = new Map<string, Venue[]>()
      for (const v of res.output.venues) {
        const list = byCell.get(v.h3) ?? []
        list.push(v)
        byCell.set(v.h3, list)
      }
      state.venuesByCell = byCell
      state.venues = res.output
      return res.output
    }

    async function execSendChat(
      args: Record<string, unknown>
    ): Promise<unknown> {
      const text = typeof args.text === "string" ? args.text.trim() : ""
      if (!text) return { error: "empty_text" }
      await postAssistantMessage(text)
      // A send_chat that lands after an analysis tool already reported a
      // semantic failure IS the model's narrated apology (per the system
      // prompt) — record it so the finish path doesn't post a second one.
      if (state.semanticFailure) state.semanticFailureNarrated = true
      return { sent: true }
    }

    async function execShowMap(
      args: Record<string, unknown>
    ): Promise<unknown> {
      const rawPins = Array.isArray(args.pins) ? args.pins : []
      const pins: OverlayPin[] = []
      for (const p of rawPins) {
        if (!p || typeof p !== "object") continue
        const o = p as Record<string, unknown>
        if (
          typeof o.id !== "string" ||
          typeof o.lat !== "number" ||
          typeof o.lng !== "number"
        )
          continue
        const kind = o.kind === "venue" ? "venue" : "candidate"
        const pin: OverlayPin = { id: o.id, lat: o.lat, lng: o.lng, kind }
        if (typeof o.rank === "number") pin.rank = o.rank
        if (typeof o.label === "string") pin.label = o.label
        pins.push(pin)
      }

      let routes: OverlayRoutes | null = null
      const drawTo =
        typeof args.draw_routes_to === "string" ? args.draw_routes_to : null
      if (drawTo) {
        const target = pins.find((p) => p.id === drawTo)
        if (target) {
          routes = {
            type: "FeatureCollection",
            features: ctx.origins.map((o) => ({
              type: "Feature",
              geometry: {
                type: "LineString",
                coordinates: [
                  [o.lng, o.lat],
                  [target.lng, target.lat],
                ],
              },
              properties: { color: o.color },
            })),
          }
        }
      }

      let focus: MapOverlay["focus"] = null
      const focusId = typeof args.focus_pin === "string" ? args.focus_pin : null
      if (focusId) {
        const target = pins.find((p) => p.id === focusId)
        if (target) focus = { lat: target.lat, lng: target.lng, zoom: 14 }
      }

      const overlay: MapOverlay = { pins, routes, focus }
      metadata.set("map", overlay)
      return { shown: true }
    }

    async function executeTool(
      name: string,
      rawArgs: string
    ): Promise<unknown> {
      const args = parseArgs(rawArgs)
      switch (name) {
        case "generate_candidates":
          return execGenerateCandidates()
        case "compute_route_matrix":
          return execComputeRouteMatrix()
        case "rank_candidates":
          return execRankCandidates()
        case "fetch_venues":
          return execFetchVenues(args)
        case "send_chat":
          return execSendChat(args)
        case "show_map":
          return execShowMap(args)
        default:
          return { error: `unknown_tool:${name}` }
      }
    }

    // 3. Tool loop.
    setStatus("planning", "Thinking…")
    const instructions = buildInstructions(ctx)
    try {
      let response = await streamTurn(openai, {
        instructions,
        input: buildHistoryInput(ctx),
      })

      for (let step = 0; step < MAX_STEPS; step++) {
        const calls = response.output.filter(
          (item): item is ResponseFunctionToolCall =>
            item.type === "function_call"
        )
        if (calls.length === 0) break

        const outputs: ResponseInputItem[] = []
        for (const call of calls) {
          const result = await executeTool(call.name, call.arguments)
          logger.info("tool executed", { tool: call.name })
          outputs.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify(result),
          })
        }

        response = await streamTurn(openai, {
          instructions,
          input: outputs,
          previousResponseId: response.id,
        })
      }

      // 4. Finish — assemble the plan deterministically from state.
      if (!state.ranked || state.ranked.length === 0) {
        // If the model already narrated this exact failure (semantic
        // failure → its own apologetic send_chat, per the system prompt),
        // skip failGracefully's chat so we never double-apologize; it still
        // marks the plan failed and sets status:error.
        return await failGracefully(
          "Sorry, I couldn't work out fair journeys for everyone right now — please try again shortly.",
          "no ranked candidates",
          { skipChat: state.semanticFailureNarrated === true }
        )
      }

      // Fetch exact door-to-door journeys (with geometry) for the top-3 areas.
      // Wrapped so any TfL blip is logged and skipped — a missing journey falls
      // back to compact chips + straight lines and NEVER fails the plan.
      setStatus("summarizing", "Fetching exact journeys…")
      try {
        const targets = state.ranked.slice(0, 3).flatMap((r) => {
          const cell = state.candidates?.find((c) => c.h3 === r.h3)
          return cell ? [{ h3: r.h3, lat: cell.lat, lng: cell.lng }] : []
        })
        if (targets.length > 0) {
          const jd = await journeyDetailsTask.triggerAndWait({
            origins,
            targets,
            ...(ctx.eventAt ? { eventAt: ctx.eventAt } : {}),
          })
          if (jd.ok && jd.output.kind === "ok") {
            const byCell = new Map<string, Map<string, PlanJourney>>()
            for (const j of jd.output.journeys) {
              let inner = byCell.get(j.h3)
              if (!inner) {
                inner = new Map()
                byCell.set(j.h3, inner)
              }
              inner.set(j.participantId, j.journey)
            }
            state.journeys = byCell
          } else if (!jd.ok) {
            logger.warn("journey-details failed (non-fatal)", {
              error: String(jd.error),
            })
          }
        }
      } catch (e) {
        logger.warn("journey-details threw (non-fatal)", { error: String(e) })
      }

      setStatus("summarizing", "Summarizing…")
      const result = assemblePlanResult(state, participantById)

      // Deterministic final overlay so the map reflects the finalized plan even
      // if the model's show_map calls were imperfect (top-3 area pins + the
      // winner's venue pins, focused/routed to the winner).
      publishFinalOverlay(result, ctx, state)

      // Persist the plan (durable write + analysis_completed event). If the
      // child fails, the plan was NOT saved — narrate it rather than claiming
      // "Plan ready" over a snapshot still stuck "running".
      const fin = await finalizePlanTask.triggerAndWait({
        analysisId,
        roomId,
        result,
      })
      if (!fin.ok) {
        return await failGracefully(
          "Sorry — I couldn't save the plan. Please try again.",
          "finalize-plan failed",
          { skipChat: state.semanticFailureNarrated === true }
        )
      }
      setStatus("done", "Plan ready")
      return { kind: "ok" as const, candidates: result.candidates.length }
    } catch (err) {
      logger.error("room-agent run failed", { error: String(err) })
      return await failGracefully(
        "Sorry, something went wrong while planning your meetup — please try again.",
        err instanceof Error ? err.message : "unknown error",
        { skipChat: state.semanticFailureNarrated === true }
      )
    }
  },
})

// --- Deterministic assembly helpers (module scope; pure over their args). ---

function assemblePlanResult(
  state: AgentState,
  participantById: Map<
    string,
    { name: string; color: string; lat: number; lng: number }
  >
): PlanResult {
  const ranked = state.ranked ?? []
  const top3 = ranked.slice(0, 3)
  const candidates = top3.map((r) => {
    // Every top-3 candidate carries its own cell's venues (fetch_venues fetched
    // all three) so each row can show venue chips; the map's winner-only venue
    // pins are handled separately in publishFinalOverlay.
    const venues = state.venuesByCell?.get(r.h3) ?? []
    return {
      h3: r.h3,
      name: r.name,
      rank: r.rank,
      overallScore: r.overallScore,
      fairnessScore: r.fairnessScore,
      avgMinutes: r.avgMinutes,
      maxMinutes: r.maxMinutes,
      perParticipant: r.perParticipant.map((p) => {
        const info = participantById.get(p.participantId)
        // Exact journey for this participant to this cell, when journey-details
        // returned one (omitted otherwise → card falls back to compact chips).
        const journey = state.journeys?.get(r.h3)?.get(p.participantId)
        return {
          participantId: p.participantId,
          name: info?.name ?? "Someone",
          color: info?.color ?? "#3B82F6",
          minutes: p.minutes,
          ...(journey ? { journey } : {}),
        }
      }),
      venues: venues.map((v) => ({
        name: v.name,
        lat: v.lat,
        lng: v.lng,
        ...(v.category ? { category: v.category } : {}),
        ...(v.fsqPlaceId ? { fsqPlaceId: v.fsqPlaceId } : {}),
        // Google Places liveness fields (ADR 0020) — threaded through so the
        // plan card / preview flow can use the exact id, rating, and verified
        // badge. Each omitted when absent (backfilled venues have no fsq id;
        // unverified venues have no verified flag).
        ...(v.googlePlaceId ? { googlePlaceId: v.googlePlaceId } : {}),
        ...(v.verified !== undefined ? { verified: v.verified } : {}),
        ...(v.source ? { source: v.source } : {}),
        ...(typeof v.rating === "number" ? { rating: v.rating } : {}),
        ...(typeof v.userRatingCount === "number"
          ? { userRatingCount: v.userRatingCount }
          : {}),
      })),
    }
  })
  return { candidates }
}

function publishFinalOverlay(
  result: PlanResult,
  ctx: LoadedContext,
  state: AgentState
): void {
  // PlanResult itself carries no cell centroid, but generate_candidates'
  // output (cached in state) does — anchor the winner area pin and route
  // endpoints on the true H3 cell centroid rather than a venue centroid
  // (which skews toward wherever venues cluster and is undefined when the
  // winner has no venues at all).
  const winner = result.candidates[0]
  if (!winner) return
  const cell = state.candidates?.find((c) => c.h3 === winner.h3)
  if (!cell) return

  const pins: OverlayPin[] = [
    {
      id: `candidate-${winner.h3}`,
      lat: cell.lat,
      lng: cell.lng,
      kind: "candidate",
      rank: winner.rank,
      label: winner.name,
    },
  ]
  // Venue pins stay at their own venue locations. Published alongside the
  // candidate pin even when empty — the overlay is still worth publishing
  // for the area + routes alone.
  winner.venues.forEach((v, i) => {
    pins.push({
      id: `venue-${winner.h3}-${i}`,
      lat: v.lat,
      lng: v.lng,
      kind: "venue",
      label: v.name,
      ...(v.fsqPlaceId ? { placeId: v.fsqPlaceId } : {}),
      ...(v.googlePlaceId ? { googlePlaceId: v.googlePlaceId } : {}),
    })
  })

  // Winner's real journeys, when journey-details captured them. Each rides run
  // metadata (256KB cap), so re-cap to 150 pts/participant; the full 50-pt/leg
  // geometry stays in the plan snapshot (assemblePlanResult).
  const winnerJourneys = state.journeys?.get(winner.h3)
  const features: OverlayRoutes["features"] = ctx.origins.flatMap((o) => {
    const legs = winnerJourneys?.get(o.participantId)?.legs ?? []
    const geoLegs = capJourneyPoints(
      legs.filter((l) => l.pathPoints && l.pathPoints.length >= 2),
      150
    )
    if (geoLegs.length > 0) {
      return geoLegs.map((l) => ({
        type: "Feature" as const,
        geometry: {
          type: "LineString" as const,
          // pathPoints are [lat, lon]; GeoJSON wants [lng, lat].
          coordinates: l.pathPoints!.map(
            ([lat, lon]) => [lon, lat] as [number, number]
          ),
        },
        properties: { color: o.color, mode: l.mode },
      }))
    }
    // Fallback: straight origin → centroid line (no journey / no geometry).
    return [
      {
        type: "Feature" as const,
        geometry: {
          type: "LineString" as const,
          coordinates: [
            [o.lng, o.lat],
            [cell.lng, cell.lat],
          ] as [number, number][],
        },
        properties: { color: o.color },
      },
    ]
  })
  const routes: OverlayRoutes = { type: "FeatureCollection", features }
  const overlay: MapOverlay = {
    pins,
    routes,
    focus: { lat: cell.lat, lng: cell.lng, zoom: 14 },
  }
  metadata.set("map", overlay)
}
