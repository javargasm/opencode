import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"

// HttpMiddleware.cors overwrites Vary: Origin with
// Vary: Access-Control-Request-Headers for OPTIONS preflights. Dynamic origin
// responses must vary by Origin so a shared cache cannot reuse one origin's
// preflight response for another.
export const corsVaryFix = HttpRouter.middleware(
  (effect) =>
    Effect.gen(function* () {
      const response = yield* effect
      const allowOrigin = response.headers["access-control-allow-origin"]
      if (!allowOrigin || allowOrigin === "*") return response

      const vary = response.headers["vary"]
      if (!vary) return HttpServerResponse.setHeader(response, "vary", "Origin")

      const tokens = vary.split(",").map((value) => value.trim().toLowerCase())
      if (tokens.includes("origin") || tokens.includes("*")) return response

      return HttpServerResponse.setHeader(response, "vary", `${vary}, Origin`)
    }),
  { global: true },
)
