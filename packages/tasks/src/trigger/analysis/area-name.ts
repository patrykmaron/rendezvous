// ---------------------------------------------------------------------------
// Shared area-name (locality) resolution for the ClickHouse analysis funnel.
//
// A candidate H3 cell's human label used to come from `any(display_area)` over
// its places, which almost always collapsed to "London": in the Holborn cell
// `locality` is "London" for 3376/3426 rows, with the specific neighbourhoods
// ("Camden Town", "Holborn") a small minority and junk values ("Greater
// London", "Area <h3>") mixed in — so `any()` returned "London" essentially
// every time. Picking the MOST-SPECIFIC locality — the most frequent value
// AFTER dropping those over-broad/junk names — surfaces a real neighbourhood.
// ---------------------------------------------------------------------------

/**
 * Over-broad or junk `locality` values that must never win the area label.
 * Trusted, hardcoded constant (NOT user input) — safe to interpolate into SQL.
 */
export const GENERIC_LOCALITIES = [
  "London",
  "Greater London",
  "England",
  "Wales",
  "Northern Ireland",
] as const

/**
 * ClickHouse subquery selecting the most-specific locality name per `h3_8`
 * cell: `topK(1)` over `locality` after dropping empty, over-broad and
 * "Area <h3>" junk values. Emits rows `(h3_8, name)`; a cell with no specific
 * locality emits NO row, so a LEFT JOIN leaves the caller's name empty and the
 * caller's own fallback ("London") applies — the cell is never dropped.
 *
 * `cellScope` is a SQL predicate on `h3_8` supplied by each call site (they
 * scope their cell set differently) — trusted SQL, never user input. Any query
 * parameters it references (e.g. {analysisId:UUID}, {cells:Array(String)}) are
 * bound at the outer chQuery/chCommand call.
 */
export function areaNameSubquery(cellScope: string): string {
  const generic = GENERIC_LOCALITIES.map((l) => `'${l}'`).join(", ")
  return `SELECT h3_8, arrayElement(topK(1)(locality), 1) AS name
          FROM places
          WHERE ${cellScope}
            AND is_closed = 0
            AND notEmpty(locality)
            AND locality NOT IN (${generic})
            AND NOT startsWith(locality, 'Area ')
          GROUP BY h3_8`
}
