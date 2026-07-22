"use client"

import * as React from "react"

import { CalendarBlankIcon } from "@phosphor-icons/react/dist/csr/CalendarBlank"

import { Button, buttonVariants } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { cn } from "@workspace/ui/lib/utils"

import { setEventTime } from "@/app/actions/settings"

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const ONE_DAY_MS = 24 * 60 * 60 * 1000

/**
 * Label for a London wall-clock "yyyy-MM-ddTHH:mm" by pure string parsing (no
 * Date-timezone maths — see G1 design §4.4). Within the coming week: "Sat 19:00";
 * further out: "Sat 26 Jul · 19:00"; unset: "Pick a time".
 */
export function formatEventAt(eventAt: string | null): string {
  if (!eventAt) return "Pick a time"
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(eventAt)
  if (!m) return "Pick a time"
  const [, y, mo, d, hh, mm] = m
  // Weekday computed from a UTC-midnight instant so the viewer's zone can't
  // shift which day it lands on.
  const dayMs = Date.parse(`${y}-${mo}-${d}T00:00:00Z`)
  const weekday = Number.isNaN(dayMs) ? "" : WEEKDAYS[new Date(dayMs).getUTCDay()]
  const delta = dayMs - Date.now()
  const soon = delta < SEVEN_DAYS_MS && delta > -ONE_DAY_MS
  if (soon) return `${weekday} ${hh}:${mm}`
  return `${weekday} ${Number(d)} ${MONTHS[Number(mo) - 1]} · ${hh}:${mm}`
}

/** Current local time as a datetime-local value ("yyyy-MM-ddTHH:mm"). */
function nowLocalValue(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Header chip that shows and edits the room's target meeting time. Owns the
 * popover + draft state; `eventAt` is the authoritative value from RoomView
 * (seeded from the server, kept live by the settings:update listener), and
 * `onChanged` optimistically reflects a successful write before the echo lands.
 */
export function EventTimeChip({
  roomId,
  sessionToken,
  eventAt,
  onChanged,
}: {
  roomId: string
  sessionToken: string
  eventAt: string | null
  onChanged: (next: string | null) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState(eventAt ?? "")
  const [error, setError] = React.useState<string | null>(null)
  const [pending, startTransition] = React.useTransition()

  // Re-seed the draft from the authoritative value each time the popover opens
  // (it may have changed underneath us via another tab's settings:update while
  // closed). Done here rather than in an effect to avoid a cascading render.
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (next) {
        setDraft(eventAt ?? "")
        setError(null)
      }
      setOpen(next)
    },
    [eventAt]
  )

  const commit = React.useCallback(
    (next: string | null) => {
      setError(null)
      startTransition(async () => {
        const res = await setEventTime(sessionToken, roomId, next)
        if (!res.ok) {
          setError(res.error)
          return
        }
        onChanged(next)
        setOpen(false)
      })
    },
    [sessionToken, roomId, onChanged]
  )

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        aria-label="Set meeting time"
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "shrink-0 gap-1.5 text-muted-foreground"
        )}
      >
        <CalendarBlankIcon />
        <span className={cn(!eventAt && "text-muted-foreground")}>
          {formatEventAt(eventAt)}
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-2">
        <p className="text-xs font-medium">Meeting time</p>
        <p className="text-[11px] text-muted-foreground">
          When you plan to meet — used to time everyone&apos;s journeys.
        </p>
        <Input
          type="datetime-local"
          min={nowLocalValue()}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Meeting date and time"
        />
        {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending || !eventAt}
            onClick={() => commit(null)}
          >
            Clear
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={pending || !draft}
            onClick={() => commit(draft)}
          >
            Set time
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
