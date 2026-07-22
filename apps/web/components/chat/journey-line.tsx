"use client"

import * as React from "react"

import { BicycleIcon } from "@phosphor-icons/react/dist/csr/Bicycle"
import { BoatIcon } from "@phosphor-icons/react/dist/csr/Boat"
import { BusIcon } from "@phosphor-icons/react/dist/csr/Bus"
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown"
import { PathIcon } from "@phosphor-icons/react/dist/csr/Path"
import { PersonSimpleWalkIcon } from "@phosphor-icons/react/dist/csr/PersonSimpleWalk"
import { TrainIcon } from "@phosphor-icons/react/dist/csr/Train"
import { TrainSimpleIcon } from "@phosphor-icons/react/dist/csr/TrainSimple"
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning"

import { cn } from "@workspace/ui/lib/utils"

import type { PlanCandidate } from "@/lib/types"

type Participant = PlanCandidate["perParticipant"][number]
// Minimal structural type for a Phosphor icon (we only pass className) — avoids
// importing the package-root `Icon` type, whose barrel doesn't resolve here.
type IconCmp = React.ComponentType<{ className?: string }>

/** TfL journey-planner mode id → Phosphor icon (G1 design §5.2). */
function modeIcon(mode: string): IconCmp {
  switch (mode) {
    case "tube":
      return TrainSimpleIcon
    case "dlr":
    case "overground":
    case "elizabeth-line":
    case "national-rail":
    case "tram":
      return TrainIcon
    case "bus":
      return BusIcon
    case "walking":
      return PersonSimpleWalkIcon
    case "cycle":
      return BicycleIcon
    case "river-bus":
      return BoatIcon
    default:
      return PathIcon
  }
}

/** London-local ISO → "HH:mm" by string slice (no timezone maths, G1 §4.4). */
function hhmm(iso: string): string {
  const t = iso.indexOf("T")
  return t >= 0 ? iso.slice(t + 1, t + 6) : iso
}

function mins(value: number): string {
  return `${Math.round(value)}m`
}

/**
 * One participant's journey to a candidate area, rendered under the plan-card
 * row. Collapsed: coloured dot · non-walking mode-icon sequence · "24 min · 1
 * change · leave by 18:32" (the leave-by only when the room has an event time —
 * see PlanCard). Expanding reveals the leg list (line/instruction + times, with
 * a disrupted tint). When the participant has no captured journey, it degrades
 * to a plain dot + minutes row. Its own toggle button lives OUTSIDE the row's
 * focus button (invalid to nest) — the parent renders these as siblings.
 */
export function JourneyLine({
  participant,
  eventAt,
  expanded,
  onToggle,
}: {
  participant: Participant
  eventAt: string | null
  expanded: boolean
  onToggle: () => void
}) {
  const j = participant.journey

  if (!j) {
    return (
      <div
        className="flex items-center gap-1.5 py-0.5 text-[11px] text-muted-foreground"
        title={`${participant.name}: ${mins(participant.minutes)}`}
      >
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: participant.color }}
        />
        <span className="tabular-nums">{mins(participant.minutes)}</span>
      </div>
    )
  }

  const nonWalk = j.legs.filter((l) => l.mode !== "walking")
  const changes = Math.max(0, nonWalk.length - 1)
  const iconLegs = nonWalk.length > 0 ? nonWalk : j.legs.slice(0, 1)

  const summary: string[] = [`${Math.round(j.durationMinutes)} min`]
  if (changes > 0) summary.push(`${changes} change${changes > 1 ? "s" : ""}`)
  if (eventAt && j.startDateTime) summary.push(`leave by ${hhmm(j.startDateTime)}`)

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        title={`${participant.name} · arrives ${hhmm(j.arrivalDateTime)}`}
        className="flex w-full items-center gap-1.5 py-0.5 text-left outline-none"
      >
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: participant.color }}
        />
        <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
          {iconLegs.map((leg, i) => {
            const Ic = modeIcon(leg.mode)
            return <Ic key={i} className="size-3.5" />
          })}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground tabular-nums">
          {summary.join(" · ")}
        </span>
        <CaretDownIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180"
          )}
        />
      </button>

      {expanded ? (
        <ul className="mt-0.5 ml-3.5 flex flex-col gap-1 border-l border-border/60 py-1 pl-2.5">
          {j.legs.map((leg, i) => {
            const Ic = modeIcon(leg.mode)
            return (
              <li
                key={i}
                className={cn(
                  "flex items-start gap-1.5 text-[11px]",
                  leg.isDisrupted && "text-amber-600 dark:text-amber-400"
                )}
              >
                <Ic className="mt-0.5 size-3 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="text-foreground">
                    {leg.lineName ?? leg.instruction}
                  </span>
                  {leg.isDisrupted ? (
                    <WarningIcon className="ml-1 inline size-3 align-[-2px]" />
                  ) : null}
                </span>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {hhmm(leg.departureTime)}–{hhmm(leg.arrivalTime)}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
