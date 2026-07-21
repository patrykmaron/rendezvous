import { logger, retry } from "@trigger.dev/sdk"

const TFL_BASE = "https://api.tfl.gov.uk"

// TfL error bodies are not reliably JSON: ApiError JSON for entity/argument
// errors, plain text for invalid-key 429s, HTML for Cloudflare 403s.
export class TflHttpError extends Error {
  readonly status: number
  readonly url: string
  readonly bodySnippet: string

  constructor(status: number, url: string, bodySnippet: string) {
    super(`TfL request failed with ${status}: ${bodySnippet.slice(0, 200)}`)
    this.name = "TflHttpError"
    this.status = status
    this.url = url
    this.bodySnippet = bodySnippet
  }
}

export async function tflHttpError(res: Response): Promise<TflHttpError> {
  return new TflHttpError(res.status, res.url, (await res.text()).slice(0, 500))
}

/**
 * Fetch from the TfL Unified API with in-run retries (429/5xx backoff via
 * retry.fetch) and a one-shot secondary-key fallback. Returns the Response
 * as-is: callers own status routing (300 disambiguation and 404 are semantic
 * outcomes for some endpoints).
 *
 * The app_key travels as a header, never a query param — retry.fetch records
 * the full request URL in span attributes visible in the Trigger dashboard.
 */
export async function tflFetch(
  path: string,
  params?: Record<string, string | undefined>
): Promise<Response> {
  const primaryKey = process.env.TFL_PRIMARY_KEY
  const secondaryKey = process.env.TFL_SECONDARY_KEY
  if (!primaryKey) {
    throw new Error(
      "TFL_PRIMARY_KEY is not set (root .env locally, Trigger dashboard when deployed)"
    )
  }

  const url = new URL(TFL_BASE + path)
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value)
  }

  const attempt = (appKey: string) =>
    retry.fetch(url, {
      headers: { app_key: appKey },
      // Without timeoutInMs the `timeout` retry strategy below never fires —
      // retry.fetch only aborts via its own timer. 15s bounds a stalled
      // connection well inside the tasks' 60-120s maxDuration.
      timeoutInMs: 15_000,
      retry: {
        byStatus: {
          "429": {
            strategy: "backoff",
            maxAttempts: 3,
            factor: 2,
            minTimeoutInMs: 500,
            maxTimeoutInMs: 5000,
            randomize: true,
          },
          "500-599": {
            strategy: "backoff",
            maxAttempts: 3,
            factor: 2,
            minTimeoutInMs: 1000,
            maxTimeoutInMs: 10000,
            randomize: true,
          },
        },
        timeout: {
          maxAttempts: 3,
          factor: 2,
          minTimeoutInMs: 1000,
          maxTimeoutInMs: 10000,
          randomize: true,
        },
        connectionError: {
          maxAttempts: 3,
          factor: 2,
          minTimeoutInMs: 1000,
          maxTimeoutInMs: 10000,
          randomize: true,
        },
      },
    })

  const primary = await attempt(primaryKey)
  // TfL signals BOTH an invalid key and rate limiting as 429 (403 is
  // Cloudflare bot filtering, never credentials), so a still-429 response
  // after retry.fetch's backoff gets exactly one attempt on the other key.
  if (primary.status === 429 && secondaryKey) {
    const bodySnippet = (await primary.text()).slice(0, 500)
    logger.warn(
      "TfL primary key rejected or rate-limited, retrying with secondary key",
      {
        url: url.toString(),
        bodySnippet,
      }
    )
    return attempt(secondaryKey)
  }
  return primary
}

// Parse a response body as JSON, with the byte count logged so oversized
// payloads are visible in the dashboard. Only call this for statuses known to
// carry JSON (200, 300) — error bodies may be plain text or HTML.
export async function tflJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  logger.info("tfl response", {
    url: res.url,
    status: res.status,
    bytes: text.length,
  })
  try {
    return JSON.parse(text) as T
  } catch {
    throw new TflHttpError(res.status, res.url, text.slice(0, 500))
  }
}
