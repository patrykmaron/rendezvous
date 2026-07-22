import type { z } from "zod"

import type {
  BikePointSearchHit,
  BikePointStatus,
  DisambiguationSection,
  JourneyOption,
  PlanJourneyOutput,
  TransportMode,
} from "./schemas"
import {
  rawDisambiguationResult,
  rawDisambiguationSection,
  rawItineraryResult,
  rawMode,
  rawPlace,
} from "./schemas"

/** Max geometry vertices kept per leg after downsampling (~1 point/8s). */
const MAX_PATH_POINTS = 50

/** Pick the human line/route name, treating "" as absent (walking legs). */
function pickLineName(
  routeOptions:
    | Array<{ name?: string | null; lineIdentifier?: { name?: string } }>
    | undefined
): string | undefined {
  const ro = routeOptions?.[0]
  const name = ro?.name?.trim()
  if (name) return name
  const alt = ro?.lineIdentifier?.name?.trim()
  return alt ? alt : undefined
}

/**
 * Decode a TfL `path.lineString` (a JSON string of [lat, lon] pairs) into a
 * downsampled [lat, lon][]. Malformed JSON or non-2-number entries are dropped;
 * returns undefined when fewer than 2 usable points remain (a line needs two).
 */
function decodePathPoints(
  lineString: string | undefined
): [number, number][] | undefined {
  if (!lineString) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(lineString)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  const points: [number, number][] = []
  for (const entry of parsed) {
    if (
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === "number" &&
      typeof entry[1] === "number"
    ) {
      points.push([entry[0], entry[1]])
    }
  }
  if (points.length < 2) return undefined
  return downsample(points)
}

/** Uniform-stride downsample to <= MAX_PATH_POINTS, always keeping first+last,
 *  rounding to 5 dp (~1m) to shave JSON bytes. */
function downsample(points: [number, number][]): [number, number][] {
  const round5 = (n: number): number => Math.round(n * 1e5) / 1e5
  const rounded = points.map(
    ([a, b]) => [round5(a), round5(b)] as [number, number]
  )
  if (rounded.length <= MAX_PATH_POINTS) return rounded
  const stride = (rounded.length - 1) / (MAX_PATH_POINTS - 1)
  const out: [number, number][] = []
  for (let i = 0; i < MAX_PATH_POINTS; i++) {
    out.push(rounded[Math.round(i * stride)]!)
  }
  out[out.length - 1] = rounded[rounded.length - 1]! // guarantee the last point
  return out
}

export function mapJourneyResponse(
  body: unknown,
  opts?: { includeGeometry?: boolean }
): JourneyOption[] {
  const raw = rawItineraryResult.parse(body)
  return (raw.journeys ?? []).map((journey) => ({
    startDateTime: journey.startDateTime ?? "",
    arrivalDateTime: journey.arrivalDateTime ?? "",
    durationMinutes: journey.duration ?? 0,
    fareTotalPence: journey.fare?.totalCost,
    legs: (journey.legs ?? []).map((leg) => {
      const lineName = pickLineName(leg.routeOptions)
      const pathPoints = opts?.includeGeometry
        ? decodePathPoints(leg.path?.lineString)
        : undefined
      return {
        mode: leg.mode?.id ?? leg.mode?.name ?? "unknown",
        ...(lineName ? { lineName } : {}),
        instruction:
          leg.instruction?.summary ?? leg.instruction?.detailed ?? "",
        departureTime: leg.departureTime ?? "",
        arrivalTime: leg.arrivalTime ?? "",
        ...(leg.duration !== undefined
          ? { durationMinutes: leg.duration }
          : {}),
        departurePoint: {
          lat: leg.departurePoint?.lat ?? 0,
          lon: leg.departurePoint?.lon ?? 0,
        },
        arrivalPoint: {
          lat: leg.arrivalPoint?.lat ?? 0,
          lon: leg.arrivalPoint?.lon ?? 0,
        },
        distanceMetres: leg.distance,
        isDisrupted: leg.isDisrupted ?? false,
        ...(pathPoints ? { pathPoints } : {}),
      }
    }),
  }))
}

function mapDisambiguationSection(
  section: z.infer<typeof rawDisambiguationSection> | undefined
): DisambiguationSection | undefined {
  if (!section) return undefined
  return {
    matchStatus: section.matchStatus ?? "unknown",
    options: (section.disambiguationOptions ?? []).flatMap((option) =>
      option.parameterValue === undefined
        ? []
        : [
            {
              parameterValue: option.parameterValue,
              commonName: option.place?.commonName,
              lat: option.place?.lat,
              lon: option.place?.lon,
              matchQuality: option.matchQuality,
            },
          ]
    ),
  }
}

export function mapDisambiguation(body: unknown): PlanJourneyOutput {
  const raw = rawDisambiguationResult.parse(body)
  return {
    kind: "disambiguation",
    from: mapDisambiguationSection(raw.fromLocationDisambiguation),
    to: mapDisambiguationSection(raw.toLocationDisambiguation),
    via: mapDisambiguationSection(raw.viaLocationDisambiguation),
  }
}

type RawProps = NonNullable<z.infer<typeof rawPlace>["additionalProperties"]>

function propValue(props: RawProps, key: string): string | undefined {
  return props.find((p) => p.key === key)?.value ?? undefined
}

function propNumber(props: RawProps, key: string): number | undefined {
  const value = propValue(props, key)
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? undefined : parsed
}

export function mapBikePoint(body: unknown): BikePointStatus {
  const place = rawPlace.parse(body)
  const props = place.additionalProperties ?? []
  const nbBikes = propNumber(props, "NbBikes") ?? 0
  const nbEmptyDocks = propNumber(props, "NbEmptyDocks") ?? 0
  const nbDocks = propNumber(props, "NbDocks") ?? 0
  return {
    id: place.id ?? "",
    commonName: place.commonName ?? "",
    lat: place.lat ?? 0,
    lon: place.lon ?? 0,
    nbBikes,
    nbEmptyDocks,
    nbDocks,
    brokenDocks: Math.max(0, nbDocks - (nbBikes + nbEmptyDocks)),
    installed: propValue(props, "Installed") === "true",
    locked: propValue(props, "Locked") === "true",
    standardBikes: propNumber(props, "NbStandardBikes"),
    eBikes: propNumber(props, "NbEBikes"),
  }
}

export function mapBikePointSearchHit(body: unknown): BikePointSearchHit {
  const place = rawPlace.parse(body)
  return {
    id: place.id ?? "",
    commonName: place.commonName ?? "",
    lat: place.lat ?? 0,
    lon: place.lon ?? 0,
  }
}

export function mapMode(body: unknown): TransportMode {
  const mode = rawMode.parse(body)
  return {
    modeName: mode.modeName ?? "",
    isTflService: mode.isTflService ?? false,
    isFarePaying: mode.isFarePaying ?? false,
    isScheduledService: mode.isScheduledService ?? false,
  }
}
