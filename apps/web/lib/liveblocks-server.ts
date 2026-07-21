import { Liveblocks } from "@liveblocks/node"

import type { RoomEvent } from "@/liveblocks.config"

// SERVER-ONLY. Fires ephemeral room nudges from server actions / route
// handlers (ADR 0012 — Liveblocks holds nothing durable). Never import this
// from a client component: it needs LIVEBLOCKS_SECRET_KEY.
//
// A near-identical ~10-line copy lives at packages/tasks/src/lib/liveblocks.ts
// for Trigger.dev tasks — a package must not import from an app, so the two
// are deliberately duplicated rather than shared.

let client: Liveblocks | null = null

function getLiveblocks(): Liveblocks {
  if (!client) {
    client = new Liveblocks({ secret: process.env.LIVEBLOCKS_SECRET_KEY! })
  }
  return client
}

export async function broadcastRoomEvent(
  roomId: string,
  event: RoomEvent
): Promise<void> {
  await getLiveblocks().broadcastEvent(`room:${roomId}`, event)
}
