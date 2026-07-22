"use client"

import * as React from "react"

import { SlidersHorizontalIcon } from "@phosphor-icons/react/dist/csr/SlidersHorizontal"
import { WheelchairIcon } from "@phosphor-icons/react/dist/csr/Wheelchair"

import { Button, buttonVariants } from "@workspace/ui/components/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { cn } from "@workspace/ui/lib/utils"

import { setTravelPrefs } from "@/app/actions/origin"
import {
  TRAVEL_MODE_GROUPS,
  expandGroups,
  groupsFromModes,
  type TravelModeGroupId,
} from "@/lib/travel"
import type { OriginPoint } from "@/lib/types"

/**
 * Travel-preferences popover in the map's set-origin cluster. Grouped mode
 * toggles (expanded to TfL mode ids via lib/travel — the web mirror of the
 * pipeline's whitelist) plus a step-free switch. Saving calls setTravelPrefs on
 * this member's existing origin row; prefs feed routing, not the pin, so nothing
 * re-renders on the map. Seeded from `mine` (my entry in the authenticated
 * origins list), re-seeded each time it opens.
 */
export function TravelPrefsPopover({
  roomId,
  sessionToken,
  mine,
}: {
  roomId: string
  sessionToken: string
  mine: OriginPoint
}) {
  const [open, setOpen] = React.useState(false)
  const [groups, setGroups] = React.useState<Set<TravelModeGroupId>>(() =>
    groupsFromModes(mine.transportModes)
  )
  const [stepFree, setStepFree] = React.useState(!!mine.requiresStepFree)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, startTransition] = React.useTransition()

  // Re-seed from the saved prefs each time the popover opens (they may have
  // changed since last open). Done in the open handler rather than an effect to
  // avoid a cascading render.
  const handleOpenChange = (next: boolean) => {
    if (next) {
      setGroups(groupsFromModes(mine.transportModes))
      setStepFree(!!mine.requiresStepFree)
      setError(null)
    }
    setOpen(next)
  }

  const toggleGroup = (id: TravelModeGroupId) => {
    setGroups((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const save = () => {
    setError(null)
    startTransition(async () => {
      const res = await setTravelPrefs(sessionToken, roomId, {
        transportModes: expandGroups(groups),
        requiresStepFree: stepFree,
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      setOpen(false)
    })
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        aria-label="Travel preferences"
        title="Travel preferences"
        className={cn(
          buttonVariants({ variant: "outline", size: "icon-sm" }),
          "shadow-md"
        )}
      >
        <SlidersHorizontalIcon />
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-60 space-y-3">
        <div className="space-y-1.5">
          <p className="text-xs font-medium">How you&apos;ll travel</p>
          <div className="flex flex-wrap gap-1.5">
            {TRAVEL_MODE_GROUPS.map((g) => {
              const on = groups.has(g.id)
              return (
                <button
                  key={g.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleGroup(g.id)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[11px] transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    on
                      ? "border-foreground bg-foreground text-background"
                      : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  {g.label}
                </button>
              )
            })}
          </div>
          <p className="text-[10px] text-muted-foreground">
            Walking is always included.
          </p>
        </div>

        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5">
            <WheelchairIcon className="size-3.5" />
            Step-free only
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={stepFree}
            aria-label="Step-free only"
            onClick={() => setStepFree((v) => !v)}
            className={cn(
              "relative h-4 w-7 shrink-0 rounded-full transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
              stepFree ? "bg-primary" : "bg-muted-foreground/40"
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 size-3 rounded-full bg-background transition-transform",
                stepFree ? "translate-x-3.5" : "translate-x-0.5"
              )}
            />
          </button>
        </div>

        {error ? <p className="text-[11px] text-destructive">{error}</p> : null}

        <div className="flex justify-end">
          <Button type="button" size="sm" disabled={pending} onClick={save}>
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
