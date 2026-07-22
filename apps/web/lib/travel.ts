// ---------------------------------------------------------------------------
// Web-side mirror of the travel-preference vocabulary. The routing pipeline
// owns the authoritative copy in packages/tasks/src/trigger/analysis/travel.ts
// (TFL_MODE_WHITELIST / DEFAULT_MODES / modesFor). Web MUST NOT import the
// @workspace/tasks runtime — the documented liveblocks-twin convention — so the
// whitelist is duplicated here as a plain constant. KEEP THE TWO IN SYNC: any
// mode id added there must be added here (and vice versa), or a pref the UI can
// set will be silently dropped by the pipeline (or vice versa).
//
// Storage convention: participant_origins.transport_modes holds raw TfL
// journey-planner mode ids. "walking" is always appended by the pipeline
// (modesFor), so it is not surfaced as a toggle here.
// ---------------------------------------------------------------------------

/** Live journey-planner ids we allow through (mirror of TFL_MODE_WHITELIST). */
export const TFL_MODE_WHITELIST: readonly string[] = [
  "tube",
  "bus",
  "walking",
  "dlr",
  "overground",
  "elizabeth-line",
  "cycle",
  "national-rail",
  "tram",
  "river-bus",
]

/**
 * Grouped toggles shown in the travel-prefs popover. Each expands to a set of
 * whitelisted TfL mode ids. The defaults (transit + bus on, cycle off) expand
 * to today's DEFAULT_MODES once the pipeline appends "walking".
 */
export const TRAVEL_MODE_GROUPS = [
  {
    id: "transit",
    label: "Tube & train",
    modes: ["tube", "dlr", "overground", "elizabeth-line"],
    defaultOn: true,
  },
  { id: "bus", label: "Bus", modes: ["bus"], defaultOn: true },
  { id: "cycle", label: "Cycle", modes: ["cycle"], defaultOn: false },
] as const

export type TravelModeGroupId = (typeof TRAVEL_MODE_GROUPS)[number]["id"]

/** The set of group ids that are on by default (no stored prefs yet). */
export function defaultActiveGroupIds(): Set<TravelModeGroupId> {
  return new Set(
    TRAVEL_MODE_GROUPS.filter((g) => g.defaultOn).map((g) => g.id)
  )
}

/**
 * Expand a set of selected group ids to the flat, deduped list of TfL mode ids
 * to store. "walking" is intentionally omitted — the pipeline appends it.
 */
export function expandGroups(active: Iterable<TravelModeGroupId>): string[] {
  const activeSet = new Set(active)
  const out = new Set<string>()
  for (const g of TRAVEL_MODE_GROUPS) {
    if (activeSet.has(g.id)) for (const m of g.modes) out.add(m)
  }
  return [...out]
}

/**
 * Derive which group toggles are on from a participant's stored transportModes.
 * A group is on if any of its modes is present. Absent/empty prefs fall back to
 * the defaults, matching the pipeline's modesFor fallback.
 */
export function groupsFromModes(
  modes: string[] | undefined
): Set<TravelModeGroupId> {
  if (!modes || modes.length === 0) return defaultActiveGroupIds()
  const stored = new Set(modes)
  const active = new Set<TravelModeGroupId>()
  for (const g of TRAVEL_MODE_GROUPS) {
    if (g.modes.some((m) => stored.has(m))) active.add(g.id)
  }
  // A stored pref that maps to no known group (garbage) → treat as defaults so
  // the UI never shows an all-off state that would silently unroute the user.
  return active.size === 0 ? defaultActiveGroupIds() : active
}

/** Keep only whitelisted mode ids (used to sanitise action input). */
export function sanitizeModes(modes: unknown): string[] {
  if (!Array.isArray(modes)) return []
  return [
    ...new Set(
      modes.filter(
        (m): m is string =>
          typeof m === "string" && TFL_MODE_WHITELIST.includes(m)
      )
    ),
  ]
}
