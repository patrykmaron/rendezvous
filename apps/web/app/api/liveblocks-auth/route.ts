import { Liveblocks } from "@liveblocks/node"

import { requireMember, UnauthorizedError } from "@/lib/auth"
import { UUID_RE } from "@/lib/validate"

// Liveblocks access-token endpoint. The client's LiveblocksProvider POSTs here
// with the Liveblocks room id (`room:<uuid>`) and the participant's bearer
// sessionToken; we re-verify membership server-side (never trust the client)
// and mint a scoped token. Auth failures return 401 without distinguishing
// which check failed (see requireMember).

const ROOM_PREFIX = "room:"

export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response("Bad request", { status: 400 })
  }

  const { room, sessionToken } = (body ?? {}) as {
    room?: unknown
    sessionToken?: unknown
  }

  if (typeof room !== "string" || !room.startsWith(ROOM_PREFIX)) {
    return new Response("Unauthorized", { status: 401 })
  }
  const roomId = room.slice(ROOM_PREFIX.length)
  if (typeof sessionToken !== "string" || !UUID_RE.test(roomId)) {
    return new Response("Unauthorized", { status: 401 })
  }

  let participantId: string
  let name: string
  let color: string
  try {
    const { participant } = await requireMember(sessionToken, roomId)
    participantId = participant.id
    name = participant.displayName
    color = participant.color
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return new Response("Unauthorized", { status: 401 })
    }
    throw err
  }

  const liveblocks = new Liveblocks({
    secret: process.env.LIVEBLOCKS_SECRET_KEY!,
  })
  const session = liveblocks.prepareSession(participantId, {
    userInfo: { name, color },
  })
  session.allow(room, session.FULL_ACCESS)
  const { status, body: authBody } = await session.authorize()
  return new Response(authBody, {
    status,
    headers: { "content-type": "application/json" },
  })
}
