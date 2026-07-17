-- Journey results per (analysis, participant, candidate area), inserted by
-- Trigger.dev route-calculation tasks. analysis_id joins to Postgres
-- plan_snapshots.analysis_id; room_revision detects stale analyses.

CREATE TABLE IF NOT EXISTS rendezvous.route_observations
(
    `analysis_id` UUID,
    `room_id` UUID,
    `room_revision` UInt32,
    `participant_id` UUID,
    `candidate_h3` UInt64,
    `provider` LowCardinality(String),
    `transport_mode` LowCardinality(String),
    `departure_time` DateTime('UTC'),
    `duration_seconds` UInt32,
    `walking_seconds` UInt32,
    `interchange_count` UInt8,
    `accessibility_ok` UInt8,
    `route_status` LowCardinality(String),
    `calculated_at` DateTime('UTC') DEFAULT now()
)
ENGINE = MergeTree
ORDER BY (room_id, analysis_id, participant_id, candidate_h3);
