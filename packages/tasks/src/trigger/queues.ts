import { queue, type Queue } from "@trigger.dev/sdk"

/**
 * Shared queue for every TfL Unified API task. The API allows 500 req/min per
 * key (ADR 0013); capping concurrency here keeps the analysis fan-out
 * (participants × candidate areas ≈ 120 journeys) well inside that budget and
 * gives one place to throttle if a key is rate-limited.
 */
export const tflQueue: Queue = queue({ name: "tfl", concurrencyLimit: 5 })
