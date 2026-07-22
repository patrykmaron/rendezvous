"use client"

import * as React from "react"

import { useUpdateMyPresence } from "@liveblocks/react/suspense"
import { PaperPlaneRightIcon } from "@phosphor-icons/react/dist/csr/PaperPlaneRight"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"

// How long after the last keystroke we consider the user to have stopped
// typing (ms). Also cleared eagerly on send and blur.
const TYPING_IDLE_MS = 1500
const CONTENT_MAX = 2000

/**
 * The message composer. Owns only the draft text + typing-presence lifecycle;
 * the actual optimistic append and durable send live in the parent (chat
 * panel) via `onSubmit`. `isTyping` presence is set true on input and cleared
 * after an idle timeout, on send, and on blur (ADR 0012 — ephemeral only).
 */
export function Composer({
  onSubmit,
  disabled = false,
}: {
  onSubmit: (content: string) => void
  disabled?: boolean
}) {
  const updateMyPresence = useUpdateMyPresence()
  const [value, setValue] = React.useState("")
  const idleTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // Show a "@agent" completion hint while the draft's trailing token is a
  // partial @-mention and the mention isn't already present. Tab or a click
  // completes it to "@agent ".
  const lastToken = value.split(/\s+/).pop() ?? ""
  const showAgentHint = lastToken.startsWith("@") && !/@agent\b/i.test(value)

  const completeAgentMention = React.useCallback(() => {
    setValue((v) => v.replace(/@\S*$/, "@agent "))
    updateMyPresence({ isTyping: true })
  }, [updateMyPresence])

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (showAgentHint && event.key === "Tab" && !event.shiftKey) {
      event.preventDefault()
      completeAgentMention()
    }
  }

  const stopTyping = React.useCallback(() => {
    if (idleTimer.current) {
      clearTimeout(idleTimer.current)
      idleTimer.current = null
    }
    updateMyPresence({ isTyping: false })
  }, [updateMyPresence])

  // Clear the idle timer if the composer unmounts mid-type.
  React.useEffect(() => {
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current)
    }
  }, [])

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    setValue(event.target.value)
    updateMyPresence({ isTyping: true })
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => {
      idleTimer.current = null
      updateMyPresence({ isTyping: false })
    }, TYPING_IDLE_MS)
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const content = value.trim()
    if (!content) return
    onSubmit(content)
    setValue("")
    stopTyping()
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="relative flex shrink-0 items-center gap-2 border-t border-border p-3"
    >
      {showAgentHint ? (
        <div className="absolute bottom-full left-3 mb-1">
          <button
            type="button"
            // Keep the input focused when the pill is clicked (mousedown steals
            // focus otherwise), so completion doesn't blur the composer.
            onMouseDown={(event) => event.preventDefault()}
            onClick={completeAgentMention}
            className="rounded-full border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground shadow-sm hover:bg-accent"
          >
            <span className="font-medium text-foreground">@agent</span> — ask for
            a plan
          </button>
        </div>
      ) : null}
      <Input
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={stopTyping}
        disabled={disabled}
        maxLength={CONTENT_MAX}
        autoComplete="off"
        placeholder="Message the room…"
        aria-label="Message"
      />
      <Button
        type="submit"
        size="icon"
        aria-label="Send message"
        disabled={disabled || value.trim().length === 0}
      >
        <PaperPlaneRightIcon weight="fill" />
      </Button>
    </form>
  )
}
