import { auth } from "@trigger.dev/sdk"

import { bearerToken, requireMember, UnauthorizedError } from "@/lib/auth"

// Mints a scoped Trigger.dev public token so the browser can subscribe to this
// room's realtime runs + streams WITHOUT ever seeing the server secret key.
// Membership is proven with the bearer sessionToken (Authorization header only
// — see bearerToken). The token is read-scoped to the `room:<id>` run tag, so a
// member of room A can never read room B's runs. Client caches it in memory and
// refetches on 401 / before it expires (~1h). Requires TRIGGER_SECRET_KEY on
// the server — without it createPublicToken throws (500), which the client
// treats as "no realtime yet".

export async function GET(
  request: Request,
  ctx: { params: Promise<{ roomId: string }> }
): Promise<Response> {
  const { roomId } = await ctx.params

  try {
    await requireMember(bearerToken(request), roomId)
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return new Response("Unauthorized", { status: 401 })
    }
    throw err
  }

  const token = await auth.createPublicToken({
    scopes: { read: { tags: [`room:${roomId}`] } },
    expirationTime: "1hr",
  })

  return Response.json({ token })
}
