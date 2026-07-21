"use client"

import { SmileyIcon } from "@phosphor-icons/react/dist/csr/Smiley"
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle"

import { Avatar, AvatarFallback } from "@workspace/ui/components/avatar"
import {
  Bubble,
  BubbleContent,
  BubbleReactions,
} from "@workspace/ui/components/bubble"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "@workspace/ui/components/message"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { ASSISTANT_AUTHOR } from "@/lib/persona"
import { REACTION_EMOJIS } from "@/lib/reactions"
import type { ChatMessage } from "@/lib/types"

function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?"
}

/** HH:MM in 24-hour form, stable regardless of locale. */
function formatTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`
}

/** The message author's avatar: a coloured initial, or the Sparkle persona. */
function AuthorAvatar({ message }: { message: ChatMessage }) {
  const isPersona = message.participantId === null
  const color = message.author?.color ?? ASSISTANT_AUTHOR.color
  const name = message.author?.name ?? ASSISTANT_AUTHOR.name
  return (
    <Avatar className="size-7" title={name}>
      <AvatarFallback
        className="text-[11px] font-semibold text-white"
        style={{ backgroundColor: color }}
      >
        {isPersona ? (
          <SparkleIcon weight="fill" className="size-3.5" />
        ) : (
          initialOf(name)
        )}
      </AvatarFallback>
    </Avatar>
  )
}

export function MessageItem({
  message,
  own,
  isFirstInGroup,
  isLastInGroup,
  onToggleReaction,
}: {
  message: ChatMessage
  own: boolean
  isFirstInGroup: boolean
  isLastInGroup: boolean
  onToggleReaction: (messageId: string, emoji: string) => void
}) {
  const isPersona = message.participantId === null
  const align = own ? "end" : "start"
  const color = message.author?.color ?? ASSISTANT_AUTHOR.color
  const authorName = message.author?.name ?? ASSISTANT_AUTHOR.name

  return (
    <Message align={align}>
      {isFirstInGroup ? (
        <MessageAvatar>
          <AuthorAvatar message={message} />
        </MessageAvatar>
      ) : (
        <div className="w-8 shrink-0" aria-hidden="true" />
      )}

      <MessageContent>
        {isFirstInGroup && !own ? (
          <MessageHeader style={{ color }}>
            <span className="inline-flex items-center gap-1">
              {isPersona ? <SparkleIcon weight="fill" /> : null}
              {authorName}
            </span>
          </MessageHeader>
        ) : null}

        <Bubble variant="muted" align={align}>
          <BubbleContent
            // Author-tinted bubble: the participant's colour at low alpha, so
            // every speaker is identifiable while text stays readable in both
            // themes. color-mix keeps the tint theme-agnostic. The persona
            // gets an extra inset ring in its violet accent to stand out.
            style={{
              backgroundColor: `color-mix(in oklab, ${color} 14%, transparent)`,
              ...(isPersona
                ? {
                    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 35%, transparent)`,
                  }
                : {}),
            }}
          >
            {message.content}
          </BubbleContent>

          {message.reactions.length > 0 ? (
            <BubbleReactions
              align={align}
              // Flow the chips statically beneath the bubble (rather than the
              // default absolute overlay) so they never collide with the
              // timestamp footer or the next message in a busy list.
              className="static w-fit translate-x-0 translate-y-0 flex-wrap gap-1 bg-transparent p-0 ring-0"
            >
              {message.reactions.map((r) => (
                <Tooltip key={r.emoji}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => onToggleReaction(message.id, r.emoji)}
                        className={cn(
                          "inline-flex items-center gap-0.5 rounded-none px-1.5 py-0.5 text-[11px] leading-none ring-1 transition-colors",
                          r.reactedByMe
                            ? "bg-primary/15 ring-primary/50 text-foreground"
                            : "bg-background ring-border hover:bg-muted"
                        )}
                      >
                        <span className="text-xs leading-none">{r.emoji}</span>
                        <span className="tabular-nums">{r.count}</span>
                      </button>
                    }
                  />
                  <TooltipContent>
                    {r.names.join(", ") || r.emoji}
                  </TooltipContent>
                </Tooltip>
              ))}
            </BubbleReactions>
          ) : null}
        </Bubble>

        {isLastInGroup ? (
          <MessageFooter>{formatTime(message.createdAt)}</MessageFooter>
        ) : null}
      </MessageContent>

      {/* Hover / focus / touch reveals the reaction picker. */}
      <div className="flex items-center self-center opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:opacity-60">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Add reaction"
            className="inline-flex size-6 items-center justify-center rounded-none text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50 aria-expanded:bg-muted aria-expanded:text-foreground"
          >
            <SmileyIcon className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align={align}
            side="top"
            className="flex w-auto min-w-0 flex-row gap-0.5 p-1"
          >
            {REACTION_EMOJIS.map((emoji) => (
              <DropdownMenuItem
                key={emoji}
                onClick={() => onToggleReaction(message.id, emoji)}
                className="justify-center rounded-none px-1.5 py-1 text-base"
              >
                {emoji}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Message>
  )
}
