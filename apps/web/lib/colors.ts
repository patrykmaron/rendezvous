// Preset participant colour palette. Each room member picks one of these
// (enforced unique per room by the join/change-colour server actions), so
// avatars and map markers stay visually distinct.
export const PARTICIPANT_COLORS = [
  { name: "amber", hex: "#F59E0B" },
  { name: "orange", hex: "#F97316" },
  { name: "red", hex: "#EF4444" },
  { name: "rose", hex: "#F43F5E" },
  { name: "fuchsia", hex: "#D946EF" },
  { name: "violet", hex: "#8B5CF6" },
  { name: "blue", hex: "#3B82F6" },
  { name: "sky", hex: "#0EA5E9" },
  { name: "teal", hex: "#14B8A6" },
  { name: "emerald", hex: "#10B981" },
  { name: "lime", hex: "#84CC16" },
  { name: "pink", hex: "#EC4899" },
] as const

export type ParticipantColor = (typeof PARTICIPANT_COLORS)[number]
