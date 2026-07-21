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

export function mapJourneyResponse(body: unknown): JourneyOption[] {
  const raw = rawItineraryResult.parse(body)
  return (raw.journeys ?? []).map((journey) => ({
    startDateTime: journey.startDateTime ?? "",
    arrivalDateTime: journey.arrivalDateTime ?? "",
    durationMinutes: journey.duration ?? 0,
    fareTotalPence: journey.fare?.totalCost,
    legs: (journey.legs ?? []).map((leg) => ({
      mode: leg.mode?.id ?? leg.mode?.name ?? "unknown",
      instruction: leg.instruction?.summary ?? leg.instruction?.detailed ?? "",
      departureTime: leg.departureTime ?? "",
      arrivalTime: leg.arrivalTime ?? "",
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
    })),
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
