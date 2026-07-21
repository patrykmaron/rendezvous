// The agent's chat identity. Assistant/system messages have a null
// participantId in Postgres, so there's no participants row to join a name and
// colour from — they resolve to this fixed "Rendezvous" persona instead. Kept
// as plain data (no server imports) so both the messages API and the client
// message renderer can share the exact same name/colour.
export const ASSISTANT_AUTHOR = {
  name: "Rendezvous",
  color: "#7C3AED",
} as const
