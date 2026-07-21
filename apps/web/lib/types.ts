// Shared chat/reaction shapes. Kept framework-agnostic (plain serialisable
// types) so they can travel over Liveblocks broadcasts (see
// apps/web/liveblocks.config.ts) and API/JSON boundaries alike.

export type ChatMessage = {
  id: string
  roomId: string
  // null author = assistant/system message
  participantId: string | null
  role: "user" | "assistant" | "system"
  content: string
  // ISO-8601 string (Dates don't survive JSON / the realtime wire).
  createdAt: string
  author?: { name: string; color: string }
}

export type ReactionUpdate = {
  messageId: string
  participantId: string
  emoji: string
  action: "added" | "removed"
}
