"use client"

import { shallow } from "@liveblocks/react"
import { useOthers } from "@liveblocks/react/suspense"

function phrase(names: string[]): string | null {
  if (names.length === 0) return null
  if (names.length === 1) return `${names[0]} is typing…`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
  if (names.length === 3) {
    return `${names[0]}, ${names[1]} and ${names[2]} are typing…`
  }
  return "Several people are typing…"
}

/**
 * Live "… is typing" line, driven purely by others' ephemeral presence
 * (ADR 0012). A selector with shallow-equality keeps this from re-rendering on
 * unrelated presence churn (e.g. cursor moves). Occupies a fixed-height row so
 * the composer doesn't jump as people start and stop typing.
 */
export function TypingRow() {
  const names = useOthers(
    (others) =>
      others
        .filter((o) => o.presence.isTyping)
        .map((o) => o.info?.name)
        .filter((n): n is string => Boolean(n)),
    shallow
  )

  const text = phrase(names)

  return (
    <div className="h-5 px-3 text-[11px] text-muted-foreground">
      {text ? <span className="animate-pulse">{text}</span> : null}
    </div>
  )
}
