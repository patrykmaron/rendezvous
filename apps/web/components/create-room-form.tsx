"use client"

import * as React from "react"

import { unstable_rethrow } from "next/navigation"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"

import { createRoom } from "@/app/actions/room"

export function CreateRoomForm() {
  const [name, setName] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [isPending, startTransition] = React.useTransition()

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    startTransition(async () => {
      try {
        await createRoom(name)
      } catch (err) {
        // `redirect()` inside the createRoom server action throws a special
        // framework control-flow error that must be allowed to propagate
        // (not shown as a validation error) so Next can perform the
        // navigation. See:
        // https://nextjs.org/docs/app/api-reference/functions/unstable_rethrow
        unstable_rethrow(err)
        setError(err instanceof Error ? err.message : "Something went wrong.")
      }
    })
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <label
        htmlFor="room-name"
        className="text-xs font-medium text-muted-foreground"
      >
        Room name
      </label>
      <Input
        id="room-name"
        name="name"
        autoComplete="off"
        placeholder="Friday drinks"
        maxLength={80}
        required
        disabled={isPending}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <Button type="submit" disabled={isPending || name.trim().length === 0}>
        {isPending ? "Creating…" : "Create room"}
      </Button>
    </form>
  )
}
