"use client"

import * as React from "react"

import {
  useOthersMapped,
  useUpdateMyPresence,
} from "@liveblocks/react/suspense"

import { LiveCursor } from "./live-cursor"

/**
 * Publishes this participant's cursor position on a DOM surface (chat panel,
 * header), normalised 0..1 against that element's own bounding rect — see
 * `CursorPresence` in liveblocks.config.ts for why. Spread the returned
 * handlers onto the surface's root element. Touch input is ignored: there's
 * no hover pointer to broadcast, and `CursorOverlay` is desktop-only anyway.
 */
export function useSurfaceCursor(surface: "chat" | "header") {
  const updateMyPresence = useUpdateMyPresence()

  const onPointerMove = React.useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType !== "mouse") return
      const rect = e.currentTarget.getBoundingClientRect()
      const x = (e.clientX - rect.left) / rect.width
      const y = (e.clientY - rect.top) / rect.height
      updateMyPresence({ cursor: { surface, x, y } })
    },
    [surface, updateMyPresence]
  )

  const onPointerLeave = React.useCallback(() => {
    updateMyPresence({ cursor: null })
  }, [updateMyPresence])

  return { onPointerMove, onPointerLeave }
}

/**
 * Renders every other participant's live cursor that's currently on this
 * surface, positioned proportionally so it lands in the same relative spot
 * regardless of the recipient's window size. Desktop-only by design: no hover
 * pointer on mobile, and the chat sheet covers the map there anyway. Own
 * cursor is naturally excluded — `useOthersMapped` never includes self.
 */
export function CursorOverlay({ surface }: { surface: "chat" | "header" }) {
  const cursors = useOthersMapped((other) => ({
    cursor: other.presence.cursor,
    color: other.presence.color,
    name: other.info?.name,
  }))

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 hidden overflow-hidden md:block"
    >
      {cursors.map(([connectionId, data]) =>
        data.cursor?.surface === surface ? (
          <div
            key={connectionId}
            className="absolute"
            style={{
              left: `${data.cursor.x * 100}%`,
              top: `${data.cursor.y * 100}%`,
              transition: "left 120ms linear, top 120ms linear",
            }}
          >
            <LiveCursor color={data.color} name={data.name ?? "Guest"} />
          </div>
        ) : null
      )}
    </div>
  )
}
