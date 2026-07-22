"use server"

import { latLngToCell } from "h3-js"

import { and, eq, getDb, sql } from "@workspace/db/postgres"
import { withRoomRevision } from "@workspace/db/revision"
import { participantOrigins } from "@workspace/db/schema"

import { requireMember } from "@/lib/auth"
import { broadcastRoomEvent } from "@/lib/liveblocks-server"
import { sanitizeModes } from "@/lib/travel"

// Server actions are public HTTP endpoints (callable directly, not just from
// the map) — every input is validated here, never trusted from the client.
// requireMember throws UnauthorizedError for a missing/invalid session (an
// exceptional auth failure); an out-of-bounds coordinate is ordinary
// business-validation, returned as a typed result so the map can show it inline.

// Greater London bounding box. Origins outside it are rejected: the OLAP side
// (Foursquare places / route observations) is London-only, so a point beyond
// the wall would have no candidates to score against.
const LONDON_BBOX = {
  minLat: 51.2,
  maxLat: 51.8,
  minLng: -0.6,
  maxLng: 0.4,
} as const

// Matches ADR: participant_origins.h3_8 stores the H3 cell at resolution 8.
const H3_RESOLUTION = 8

const LABEL_MAX = 80

export type SetOriginResult =
  | { ok: true; lat: number; lng: number; label?: string }
  | { ok: false; error: string }

export async function setOrigin(
  sessionToken: string,
  roomId: string,
  point: { lat: number; lng: number; label?: string }
): Promise<SetOriginResult> {
  const { participant } = await requireMember(sessionToken, roomId)

  const lat = point?.lat
  const lng = point?.lng
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return { ok: false, error: "Invalid coordinates." }
  }
  if (
    lat < LONDON_BBOX.minLat ||
    lat > LONDON_BBOX.maxLat ||
    lng < LONDON_BBOX.minLng ||
    lng > LONDON_BBOX.maxLng
  ) {
    return {
      ok: false,
      error: "Pick a start point within Greater London.",
    }
  }

  let label: string | undefined
  if (point.label !== undefined) {
    if (typeof point.label !== "string") {
      return { ok: false, error: "Invalid label." }
    }
    const trimmed = point.label.trim()
    if (trimmed.length > LABEL_MAX) {
      return {
        ok: false,
        error: `Label must be ${LABEL_MAX} characters or fewer.`,
      }
    }
    label = trimmed.length > 0 ? trimmed : undefined
  }

  // H3 cell as a hex string — stored as-is (see the participant_origins.h3_8
  // column comment); the ClickHouse side converts it to a UInt64 decimal string.
  const h3_8 = latLngToCell(lat, lng, H3_RESOLUTION)

  await withRoomRevision({
    roomId,
    eventType: "origin_updated",
    actorParticipantId: participant.id,
    payload: { participantId: participant.id, lat, lng, ...(label ? { label } : {}) },
    // Same transaction as the revision bump + event insert, so the durable
    // origin write shares the room-row lock and can't be torn from its event.
    write: async (tx) => {
      await tx
        .insert(participantOrigins)
        .values({
          roomId,
          participantId: participant.id,
          latitude: lat,
          longitude: lng,
          h3_8,
          ...(label !== undefined ? { label } : {}),
        })
        .onConflictDoUpdate({
          // Unique per (room, participant): re-setting moves the pin in place.
          target: [participantOrigins.roomId, participantOrigins.participantId],
          set: {
            latitude: lat,
            longitude: lng,
            h3_8,
            updatedAt: sql`now()`,
            ...(label !== undefined ? { label } : {}),
          },
        })
    },
  })

  // Nudge the room to place/refresh this member's marker (ADR 0012). Fired
  // after commit and best-effort — a realtime hiccup must not fail the write.
  try {
    await broadcastRoomEvent(roomId, {
      type: "origin:update",
      participantId: participant.id,
      lat,
      lng,
      ...(label ? { label } : {}),
    })
  } catch (err) {
    console.warn("setOrigin: broadcast origin:update failed", err)
  }

  return { ok: true, lat, lng, ...(label ? { label } : {}) }
}

export type SetTravelPrefsResult = { ok: true } | { ok: false; error: string }

/**
 * Updates this member's travel preferences on their existing origin row. Prefs
 * feed the routing pipeline (which TfL modes to plan with, step-free) — they do
 * NOT move the pin, so there is deliberately no origin:update broadcast (that
 * event carries coordinates and re-renders markers): prefs are picked up by the
 * next analysis and by a fresh authenticated origins fetch. transportModes are
 * sanitised against the whitelist mirror (lib/travel.ts). No origin row yet →
 * typed prompt to set a start point first.
 */
export async function setTravelPrefs(
  sessionToken: string,
  roomId: string,
  prefs: { transportModes: string[]; requiresStepFree: boolean }
): Promise<SetTravelPrefsResult> {
  const { participant } = await requireMember(sessionToken, roomId)

  if (
    typeof prefs !== "object" ||
    prefs === null ||
    typeof prefs.requiresStepFree !== "boolean"
  ) {
    return { ok: false, error: "Invalid travel preferences." }
  }
  const transportModes = sanitizeModes(prefs.transportModes)
  const requiresStepFree = prefs.requiresStepFree

  const db = getDb()
  const [existing] = await db
    .select({ id: participantOrigins.id })
    .from(participantOrigins)
    .where(
      and(
        eq(participantOrigins.roomId, roomId),
        eq(participantOrigins.participantId, participant.id)
      )
    )
    .limit(1)
  if (!existing) {
    return { ok: false, error: "Set your start point first." }
  }

  await withRoomRevision({
    roomId,
    eventType: "origin_updated",
    actorParticipantId: participant.id,
    payload: { participantId: participant.id, transportModes, requiresStepFree },
    write: async (tx) => {
      await tx
        .update(participantOrigins)
        .set({ transportModes, requiresStepFree, updatedAt: sql`now()` })
        .where(
          and(
            eq(participantOrigins.roomId, roomId),
            eq(participantOrigins.participantId, participant.id)
          )
        )
    },
  })

  return { ok: true }
}
