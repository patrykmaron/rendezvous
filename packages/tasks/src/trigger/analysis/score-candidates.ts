import { chCommand, chQuery } from "@workspace/db/clickhouse/query"
import { logger, schemaTask } from "@trigger.dev/sdk"
import { z } from "zod"

const scoreCandidatesPayload = z.object({
  analysisId: z.uuid(),
  roomId: z.uuid(),
  roomRevision: z.number().int().nonnegative(),
  // Cells must be reachable by ALL participants to be scored (fairness gate).
  expectedParticipants: z.number().int().positive(),
})

type RankedCandidate = {
  h3: string
  name: string
  rank: number
  overallScore: number
  fairnessScore: number
  avgMinutes: number
  maxMinutes: number
  participantCount: number
  perParticipant: { participantId: string; minutes: number }[]
}

type ScoreCandidatesOutput =
  | { kind: "ok"; ranked: RankedCandidate[] }
  | { kind: "no_scores" }

const TOP_N = 5

/**
 * Rank candidate areas in ClickHouse (ADR 0008 funnel, step 3). One INSERT …
 * SELECT aggregates every ok route_observation per candidate cell, gates on
 * cells reached by all participants, and writes candidate_scores; then reads
 * the top N back with per-participant journey minutes.
 *
 * Scoring (per the brief):
 *   fairness = 1 / (1 + stddevPop(duration_seconds) / 600)
 *   speed    = 1 / (1 + avg(duration_seconds) / 1800)
 *   venue    = least(1, sum(place_count) / 200)
 *   overall  = 0.45*fairness + 0.35*speed + 0.20*venue
 */
export const scoreCandidatesTask = schemaTask({
  id: "ch-score-candidates",
  schema: scoreCandidatesPayload,
  maxDuration: 120,
  run: async ({
    analysisId,
    roomId,
    roomRevision,
    expectedParticipants,
  }): Promise<ScoreCandidatesOutput> => {
    // Column list is explicit so order can't drift from migration 3;
    // calculated_at is left to its DEFAULT now().
    await chCommand(
      `INSERT INTO candidate_scores
         (analysis_id, room_id, room_revision, candidate_h3, candidate_name,
          participant_count, average_journey_seconds, maximum_journey_seconds,
          journey_variance, total_interchanges, fairness_score,
          venue_match_score, accessibility_score, overall_score, candidate_rank)
       SELECT
         {analysisId:UUID} AS analysis_id,
         {roomId:UUID} AS room_id,
         {roomRevision:UInt32} AS room_revision,
         candidate_h3,
         candidate_name,
         participant_count,
         average_journey_seconds,
         maximum_journey_seconds,
         journey_variance,
         total_interchanges,
         fairness_score,
         venue_match_score,
         accessibility_score,
         overall_score,
         row_number() OVER (ORDER BY overall_score DESC) AS candidate_rank
       FROM (
         SELECT
           candidate_h3,
           candidate_name,
           participant_count,
           average_journey_seconds,
           maximum_journey_seconds,
           journey_variance,
           total_interchanges,
           accessibility_score,
           1 / (1 + stddev_dur / 600) AS fairness_score,
           least(1, venue_pc / 200) AS venue_match_score,
           0.45 * (1 / (1 + stddev_dur / 600))
             + 0.35 * (1 / (1 + average_journey_seconds / 1800))
             + 0.20 * (least(1, venue_pc / 200)) AS overall_score
         FROM (
           SELECT
             ro.candidate_h3 AS candidate_h3,
             uniqExact(ro.participant_id) AS participant_count,
             avg(ro.duration_seconds) AS average_journey_seconds,
             max(ro.duration_seconds) AS maximum_journey_seconds,
             varPop(ro.duration_seconds) AS journey_variance,
             stddevPop(ro.duration_seconds) AS stddev_dur,
             sum(ro.interchange_count) AS total_interchanges,
             avg(ro.accessibility_ok) AS accessibility_score,
             any(vd.pc) AS venue_pc,
             any(pl.name) AS candidate_name
           FROM route_observations ro
           LEFT JOIN (
             SELECT h3_8, sum(place_count) AS pc
             FROM area_category_counts GROUP BY h3_8
           ) vd ON ro.candidate_h3 = vd.h3_8
           LEFT JOIN (
             SELECT h3_8, any(display_area) AS name
             FROM places
             WHERE h3_8 IN (
               SELECT candidate_h3 FROM route_observations
               WHERE analysis_id = {analysisId:UUID}
             )
             GROUP BY h3_8
           ) pl ON ro.candidate_h3 = pl.h3_8
           WHERE ro.analysis_id = {analysisId:UUID} AND ro.route_status = 'ok'
           GROUP BY ro.candidate_h3
           HAVING participant_count = {expectedParticipants:UInt16}
         )
       )`,
      { analysisId, roomId, roomRevision, expectedParticipants }
    )

    const ranked = await chQuery<{
      h3: string
      candidate_name: string
      candidate_rank: number
      overall_score: number
      fairness_score: number
      average_journey_seconds: number
      maximum_journey_seconds: number
      participant_count: number
    }>(
      `SELECT toString(candidate_h3) AS h3, candidate_name, candidate_rank,
              overall_score, fairness_score, average_journey_seconds,
              maximum_journey_seconds, participant_count
       FROM candidate_scores
       WHERE analysis_id = {analysisId:UUID}
       ORDER BY candidate_rank LIMIT {n:UInt8}`,
      { analysisId, n: TOP_N }
    )

    if (ranked.length === 0) {
      logger.warn("no candidate scores produced", { analysisId })
      return { kind: "no_scores" }
    }

    // Per-participant minutes for the ranked cells, one query.
    const topCells = ranked.map((r) => r.h3)
    const perRows = await chQuery<{
      h3: string
      participantId: string
      duration_seconds: number
    }>(
      `SELECT toString(candidate_h3) AS h3,
              toString(participant_id) AS participantId,
              duration_seconds
       FROM route_observations
       WHERE analysis_id = {analysisId:UUID} AND route_status = 'ok'
         AND candidate_h3 IN (SELECT toUInt64(arrayJoin({topCells:Array(String)})))`,
      { analysisId, topCells }
    )

    const perByH3 = new Map<
      string,
      { participantId: string; minutes: number }[]
    >()
    for (const row of perRows) {
      const list = perByH3.get(row.h3) ?? []
      list.push({
        participantId: row.participantId,
        minutes: Math.round(row.duration_seconds / 60),
      })
      perByH3.set(row.h3, list)
    }

    const result: RankedCandidate[] = ranked.map((r) => ({
      h3: r.h3,
      name: r.candidate_name || "Unknown area",
      rank: r.candidate_rank,
      overallScore: r.overall_score,
      fairnessScore: r.fairness_score,
      avgMinutes: Math.round(r.average_journey_seconds / 60),
      maxMinutes: Math.round(r.maximum_journey_seconds / 60),
      participantCount: r.participant_count,
      perParticipant: perByH3.get(r.h3) ?? [],
    }))

    logger.info("candidates scored", { analysisId, ranked: result.length })
    return { kind: "ok", ranked: result }
  },
})
