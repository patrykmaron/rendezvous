"use client"

import * as React from "react"

import { useEventListener } from "@liveblocks/react/suspense"
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock"
import { CurrencyGbpIcon } from "@phosphor-icons/react/dist/csr/CurrencyGbp"
import { ForkKnifeIcon } from "@phosphor-icons/react/dist/csr/ForkKnife"
import { MapPinIcon } from "@phosphor-icons/react/dist/csr/MapPin"
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle"
import { StorefrontIcon } from "@phosphor-icons/react/dist/csr/Storefront"
import { TrainIcon } from "@phosphor-icons/react/dist/csr/Train"
import { WheelchairIcon } from "@phosphor-icons/react/dist/csr/Wheelchair"
import { XIcon } from "@phosphor-icons/react/dist/csr/X"

import { removeConstraint } from "@/app/actions/constraints"
import type { RoomSession } from "@/lib/session"
import type { ConstraintKind, ConstraintView } from "@/lib/types"

// All Phosphor icon components share one type, so `typeof ForkKnifeIcon` names
// the map's value type without reaching for the package-root `Icon` type
// (which doesn't resolve under this repo's icon subpath convention).
type IconComponent = typeof ForkKnifeIcon

const KIND_ICONS: Record<ConstraintKind, IconComponent> = {
  diet: ForkKnifeIcon,
  accessibility: WheelchairIcon,
  budget: CurrencyGbpIcon,
  area: MapPinIcon,
  time: ClockIcon,
  venue_type: StorefrontIcon,
  transport: TrainIcon,
  other: SparkleIcon,
}

// Neutral tint for room-wide chips (no author colour). A hex, not a CSS var,
// because the pill appends alpha to it (`color + "1A"`).
const NEUTRAL_COLOR = "#71717a"

/**
 * The chat's live constraint chip strip (ADR 0019). Fetches the room's
 * constraints on mount, then folds in `constraint:update` nudges (add/remove)
 * and `member:update` (author re-tint) per ADR 0012. Chips the caller may
 * delete — their own personal ones and any room-wide one — carry an X that
 * fires `removeConstraint`; removal is broadcast-driven (no optimistic local
 * patch), same as reactions.
 */
export function ConstraintChips({
  roomId,
  session,
}: {
  roomId: string
  session: RoomSession
}) {
  const [chips, setChips] = React.useState<ConstraintView[]>([])
  const [isPending, startTransition] = React.useTransition()

  React.useEffect(() => {
    let active = true
    fetch(`/api/rooms/${roomId}/constraints`, {
      headers: { Authorization: `Bearer ${session.sessionToken}` },
    })
      .then((res) => (res.ok ? res.json() : []))
      .then((data: ConstraintView[]) => {
        if (active) setChips(data)
      })
      .catch(() => {
        // Non-fatal: the strip stays empty until the next nudge lands.
      })
    return () => {
      active = false
    }
  }, [roomId, session.sessionToken])

  useEventListener(({ event }) => {
    if (event.type === "constraint:update") {
      if (event.action === "added") {
        setChips((prev) =>
          prev.some((c) => c.id === event.constraint.id)
            ? prev
            : [...prev, event.constraint]
        )
      } else {
        setChips((prev) => prev.filter((c) => c.id !== event.constraint.id))
      }
    } else if (event.type === "member:update") {
      // A colour/name change must re-tint that member's chips live.
      setChips((prev) =>
        prev.map((c) =>
          c.author && c.participantId === event.participantId
            ? { ...c, author: { name: event.name, color: event.color } }
            : c
        )
      )
    }
  })

  const removeChip = React.useCallback(
    (id: string) => {
      startTransition(async () => {
        try {
          await removeConstraint(session.sessionToken, roomId, id)
        } catch (err) {
          console.error("removeConstraint failed", err)
        }
      })
    },
    [roomId, session.sessionToken]
  )

  if (chips.length === 0) {
    return (
      <div className="px-3 py-1.5 text-xs text-muted-foreground">
        Mention dietary needs, budgets or vibes — I&apos;ll remember.
      </div>
    )
  }

  return (
    <div className="flex gap-1.5 overflow-x-auto border-t border-border px-3 py-2">
      {chips.map((c) => {
        const color = c.author?.color ?? NEUTRAL_COLOR
        const Icon = KIND_ICONS[c.kind] ?? SparkleIcon
        const deletable =
          c.participantId === null || c.participantId === session.participantId
        const authorName = c.author?.name ?? "Whole group"
        return (
          <div
            key={c.id}
            title={authorName}
            className="flex shrink-0 items-center gap-1 rounded-full border py-0.5 pr-1 pl-2 text-xs whitespace-nowrap"
            style={{
              backgroundColor: color + "1A",
              borderColor: color + "55",
              color,
            }}
          >
            <Icon
              weight={c.isHard ? "fill" : "regular"}
              className="size-3 shrink-0"
            />
            <span>{c.summary}</span>
            {deletable ? (
              <button
                type="button"
                aria-label={`Remove ${c.summary}`}
                disabled={isPending}
                onClick={() => removeChip(c.id)}
                className="flex items-center justify-center rounded-full p-0.5 hover:bg-foreground/10 disabled:opacity-50"
              >
                <XIcon className="size-3" />
              </button>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
