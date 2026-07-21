import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core"

export const roomStatuses = [
  "gathering",
  "analyzing",
  "voting",
  "decided",
] as const
export type RoomStatus = (typeof roomStatuses)[number]

export const rooms = pgTable("rooms", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  status: text("status").$type<RoomStatus>().notNull().default("gathering"),
  currentRevision: integer("current_revision").notNull().default(0),
  decidedSnapshotId: uuid("decided_snapshot_id").references(
    (): AnyPgColumn => planSnapshots.id,
    { onDelete: "set null" }
  ),
  settings: jsonb("settings").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const participants = pgTable("participants", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name").notNull(),
  // Authoritative user colour (hex from a preset palette).
  color: text("color").notNull().default("#3B82F6"),
  sessionToken: uuid("session_token").notNull().unique().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const memberRoles = ["host", "member"] as const
export type MemberRole = (typeof memberRoles)[number]

export const roomMembers = pgTable(
  "room_members",
  {
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    role: text("role").$type<MemberRole>().notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.roomId, t.participantId] }),
    index("room_members_participant_idx").on(t.participantId),
  ]
)

export const invitations = pgTable("invitations", {
  id: uuid("id").primaryKey().defaultRandom(),
  roomId: uuid("room_id")
    .notNull()
    .references(() => rooms.id, { onDelete: "cascade" }),
  code: text("code").notNull().unique(),
  createdBy: uuid("created_by").references(() => participants.id, {
    onDelete: "set null",
  }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  maxUses: integer("max_uses"),
  useCount: integer("use_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const messageRoles = ["user", "assistant", "system"] as const
export type MessageRole = (typeof messageRoles)[number]

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    // null participant = assistant/system message
    participantId: uuid("participant_id").references(() => participants.id, {
      onDelete: "set null",
    }),
    role: text("role").$type<MessageRole>().notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("messages_room_created_idx").on(t.roomId, t.createdAt)]
)

export const messageReactions = pgTable(
  "message_reactions",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.participantId, t.emoji] })]
)

export const participantOrigins = pgTable(
  "participant_origins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    label: text("label"),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    // H3 cell as hex string; convert to UInt64 decimal string for ClickHouse
    h3_8: text("h3_8").notNull(),
    transportModes: jsonb("transport_modes")
      .$type<string[]>()
      .notNull()
      .default(["tube", "bus"]),
    requiresStepFree: boolean("requires_step_free").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("participant_origins_room_participant_uq").on(
      t.roomId,
      t.participantId
    ),
  ]
)

export const constraints = pgTable(
  "constraints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    // null participant = room-wide constraint
    participantId: uuid("participant_id").references(() => participants.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(),
    isHard: boolean("is_hard").notNull().default(true),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("constraints_room_idx").on(t.roomId)]
)

export const votes = pgTable(
  "votes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    planSnapshotId: uuid("plan_snapshot_id")
      .notNull()
      .references(() => planSnapshots.id, { onDelete: "cascade" }),
    candidateH3: text("candidate_h3").notNull(),
    value: smallint("value").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("votes_snapshot_participant_candidate_uq").on(
      t.planSnapshotId,
      t.participantId,
      t.candidateH3
    ),
  ]
)

export const snapshotStatuses = [
  "pending",
  "running",
  "complete",
  "failed",
] as const
export type SnapshotStatus = (typeof snapshotStatuses)[number]

export const planSnapshots = pgTable(
  "plan_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    // Join key into ClickHouse route_observations / candidate_scores
    analysisId: uuid("analysis_id").notNull().unique().defaultRandom(),
    // Room revision the analysis ran against; compare with
    // rooms.current_revision to detect staleness
    roomRevision: integer("room_revision").notNull(),
    status: text("status").$type<SnapshotStatus>().notNull().default("pending"),
    // Denormalized top-N candidates for instant UI render
    result: jsonb("result"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("plan_snapshots_room_idx").on(t.roomId, t.createdAt)]
)

export const roomEventTypes = [
  "room_created",
  "member_joined",
  "origin_updated",
  "constraint_added",
  "constraint_removed",
  "message_sent",
  "analysis_requested",
  "analysis_completed",
  "vote_cast",
  "plan_decided",
  "reaction_added",
  "reaction_removed",
  "color_changed",
] as const
export type RoomEventType = (typeof roomEventTypes)[number]

/**
 * Append-only event log. Every durable change must, in ONE transaction:
 *
 *   UPDATE rooms SET current_revision = current_revision + 1, updated_at = now()
 *     WHERE id = $roomId RETURNING current_revision;  -- row-locks the room
 *   INSERT INTO room_events (room_id, revision, ...) VALUES ($roomId, $rev, ...);
 *
 * The RETURNING form serializes concurrent writers; unique (room_id, revision)
 * is the backstop (retry on violation). Never read-then-write the revision.
 */
export const roomEvents = pgTable(
  "room_events",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    eventType: text("event_type").$type<RoomEventType>().notNull(),
    actorParticipantId: uuid("actor_participant_id").references(
      () => participants.id,
      { onDelete: "set null" }
    ),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("room_events_room_revision_uq").on(t.roomId, t.revision)]
)

export type Room = typeof rooms.$inferSelect
export type NewRoom = typeof rooms.$inferInsert
export type Participant = typeof participants.$inferSelect
export type NewParticipant = typeof participants.$inferInsert
export type RoomMember = typeof roomMembers.$inferSelect
export type NewRoomMember = typeof roomMembers.$inferInsert
export type Invitation = typeof invitations.$inferSelect
export type NewInvitation = typeof invitations.$inferInsert
export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
export type MessageReaction = typeof messageReactions.$inferSelect
export type NewMessageReaction = typeof messageReactions.$inferInsert
export type ParticipantOrigin = typeof participantOrigins.$inferSelect
export type NewParticipantOrigin = typeof participantOrigins.$inferInsert
export type Constraint = typeof constraints.$inferSelect
export type NewConstraint = typeof constraints.$inferInsert
export type Vote = typeof votes.$inferSelect
export type NewVote = typeof votes.$inferInsert
export type PlanSnapshot = typeof planSnapshots.$inferSelect
export type NewPlanSnapshot = typeof planSnapshots.$inferInsert
export type RoomEvent = typeof roomEvents.$inferSelect
export type NewRoomEvent = typeof roomEvents.$inferInsert
