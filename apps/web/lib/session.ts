// Client-only identity storage. There are no cookies in this app: each
// browser window/tab holds its own per-room session in sessionStorage, so
// opening two windows genuinely behaves like two separate participants
// (deliberate, for demoing multiplayer with one machine). Consumers of this
// module must be "use client".

export interface RoomSession {
  participantId: string
  sessionToken: string
  name: string
  color: string
}

function storageKey(roomId: string): string {
  return `rdv:session:${roomId}`
}

function isRoomSession(value: unknown): value is RoomSession {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.participantId === "string" &&
    typeof candidate.sessionToken === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.color === "string"
  )
}

export function getRoomSession(roomId: string): RoomSession | null {
  if (typeof window === "undefined") return null
  const raw = window.sessionStorage.getItem(storageKey(roomId))
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRoomSession(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function setRoomSession(roomId: string, session: RoomSession): void {
  if (typeof window === "undefined") return
  window.sessionStorage.setItem(storageKey(roomId), JSON.stringify(session))
}

export function clearRoomSession(roomId: string): void {
  if (typeof window === "undefined") return
  window.sessionStorage.removeItem(storageKey(roomId))
}
