-- Ranked output of each analysis run: one row per candidate meeting area,
-- scored for fairness, venue coverage and accessibility in ClickHouse.

CREATE TABLE IF NOT EXISTS rendezvous.candidate_scores
(
    `analysis_id` UUID,
    `room_id` UUID,
    `room_revision` UInt32,
    `candidate_h3` UInt64,
    `candidate_name` String,
    `participant_count` UInt16,
    `average_journey_seconds` Float32,
    `maximum_journey_seconds` UInt32,
    `journey_variance` Float32,
    `total_interchanges` UInt16,
    `fairness_score` Float32,
    `venue_match_score` Float32,
    `accessibility_score` Float32,
    `overall_score` Float32,
    `candidate_rank` UInt16,
    `calculated_at` DateTime('UTC') DEFAULT now()
)
ENGINE = MergeTree
ORDER BY (room_id, analysis_id, candidate_rank);
