// The fixed emoji palette for message reactions. Shared verbatim by the
// `toggleReaction` server action (which rejects anything outside this set) and
// the client reaction picker, so the two can never drift. Plain data only — no
// server imports — so it's safe to pull into a client component.
export const REACTION_EMOJIS = [
  "👍",
  "❤️",
  "😂",
  "😮",
  "😢",
  "🎉",
  "📍",
  "🔥",
] as const

export type ReactionEmoji = (typeof REACTION_EMOJIS)[number]

export function isReactionEmoji(value: unknown): value is ReactionEmoji {
  return (
    typeof value === "string" &&
    (REACTION_EMOJIS as readonly string[]).includes(value)
  )
}
