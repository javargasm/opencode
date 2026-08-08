import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024

const it = testEffect(
  LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node]), [
    [httpClient, FetchHttpClient.layer as Layer.Layer<HttpClient.HttpClient>],
  ]),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const context = (sessionID: string, abort = AbortSignal.any([])) => ({
  ...ctx,
  sessionID: SessionID.make(sessionID),
  abort,
})

const withFetch = <A, E, R>(
  fetch: (req: Request) => Response | Promise<Response>,
  fn: (url: URL) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Bun.serve({ port: 0, fetch })),
    (server) => fn(server.url),
    (server) => Effect.sync(() => server.stop(true)),
  )

const exec = Effect.fn("WebFetchToolTest.exec")(function* (
  args: Tool.InferParameters<typeof WebFetchTool>,
  toolContext = ctx,
) {
  const info = yield* WebFetchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, toolContext)
})

function stalledResponse(started: () => void, canceled: () => void, body = new Uint8Array([1])) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body)
        started()
      },
      cancel() {
        canceled()
      },
    }),
    { headers: { "content-type": "text/plain" } },
  )
}

function expectFailure<A, E>(exit: Exit.Exit<A, E>, message: string) {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(message)
}

describe("tool.webfetch", () => {
  it.instance("returns image responses as file attachments", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      yield* withFetch(
        () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
        (url) =>
          Effect.gen(function* () {
            const result = yield* exec({ url: new URL("/image.png", url).toString(), format: "markdown" })
            expect(result.output).toBe("Image fetched successfully")
            expect(result.attachments).toBeDefined()
            expect(result.attachments?.length).toBe(1)
            expect(result.attachments?.[0].type).toBe("file")
            expect(result.attachments?.[0].mime).toBe("image/png")
            expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
            expect(result.attachments?.[0]).not.toHaveProperty("id")
            expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
            expect(result.attachments?.[0]).not.toHaveProperty("messageID")
          }),
      )
    }),
  )

  it.instance("keeps svg as text output", () =>
    withFetch(
      () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>', {
          status: 200,
          headers: { "content-type": "image/svg+xml; charset=UTF-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/image.svg", url).toString(), format: "html" })
          expect(result.output).toContain("<svg")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("keeps text responses as text output", () =>
    withFetch(
      () =>
        new Response("hello from webfetch", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text" })
          expect(result.output).toBe("hello from webfetch")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("extracts text from html without scripts or styles", () =>
    withFetch(
      () =>
        new Response(
          "<html><head><style>.hidden{}</style><script>alert('x')</script></head><body>Hello <b>world</b></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/page.html", url).toString(), format: "text" })
          expect(result.output).toBe("Hello world")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("limits concurrent fetches across sessions and times out while waiting for a permit", () =>
    Effect.gen(function* () {
      const firstStarted = Promise.withResolvers<void>()
      const secondStarted = Promise.withResolvers<void>()
      const firstCanceled = Promise.withResolvers<void>()
      const secondCanceled = Promise.withResolvers<void>()
      const requests: string[] = []

      yield* withFetch(
        (request) => {
          const pathname = new URL(request.url).pathname
          requests.push(pathname)
          if (pathname === "/hold-first") return stalledResponse(firstStarted.resolve, firstCanceled.resolve)
          if (pathname === "/hold-second") return stalledResponse(secondStarted.resolve, secondCanceled.resolve)
          return new Response("fast", { headers: { "content-type": "text/plain" } })
        },
        (url) =>
          Effect.gen(function* () {
            const first = yield* exec(
              { url: new URL("/hold-first", url).toString(), format: "text" },
              context("ses_webfetch_first"),
            ).pipe(Effect.forkChild)
            const second = yield* exec(
              { url: new URL("/hold-second", url).toString(), format: "text" },
              context("ses_webfetch_second"),
            ).pipe(Effect.forkChild)

            yield* Effect.gen(function* () {
              yield* awaitWithTimeout(
                Effect.promise(() => Promise.all([firstStarted.promise, secondStarted.promise])),
                "two response bodies did not start",
              )
              const exit = yield* awaitWithTimeout(
                exec(
                  { url: new URL("/fast", url).toString(), format: "text", timeout: 0.1 },
                  context("ses_webfetch_third"),
                ).pipe(Effect.exit),
                "queued fetch did not honor its timeout",
              )

              expectFailure(exit, "Request timed out")
              expect(requests).not.toContain("/fast")
            }).pipe(Effect.ensuring(Effect.all([Fiber.interrupt(first), Fiber.interrupt(second)], { discard: true })))
          }),
      )
    }),
  )

  it.instance("times out after response headers while the body is stalled", () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>()
      const canceled = Promise.withResolvers<void>()

      yield* withFetch(
        () => stalledResponse(started.resolve, canceled.resolve),
        (url) =>
          Effect.gen(function* () {
            const exit = yield* awaitWithTimeout(
              exec({ url: new URL("/stall", url).toString(), format: "text", timeout: 0.1 }).pipe(Effect.exit),
              "stalled response body outlived the webfetch timeout",
            )

            expectFailure(exit, "Request timed out")
            yield* awaitWithTimeout(
              Effect.promise(() => canceled.promise),
              "timed out response body was not canceled",
            )
          }),
      )
    }),
  )

  it.instance("rejects an oversized stream before EOF and cancels it", () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>()
      const canceled = Promise.withResolvers<void>()

      yield* withFetch(
        () => stalledResponse(started.resolve, canceled.resolve, new Uint8Array(MAX_RESPONSE_SIZE + 1)),
        (url) =>
          Effect.gen(function* () {
            const exit = yield* awaitWithTimeout(
              exec({ url: new URL("/oversized", url).toString(), format: "text" }).pipe(Effect.exit),
              "oversized response waited for EOF",
            )

            expectFailure(exit, "Response too large (exceeds 5MB limit)")
            yield* awaitWithTimeout(
              Effect.promise(() => canceled.promise),
              "oversized response body was not canceled",
            )
          }),
      )
    }),
  )

  it.instance("aborts a stalled stream and releases its permit", () =>
    Effect.gen(function* () {
      const firstStarted = Promise.withResolvers<void>()
      const secondStarted = Promise.withResolvers<void>()
      const firstCanceled = Promise.withResolvers<void>()
      const secondCanceled = Promise.withResolvers<void>()
      const controller = new AbortController()

      yield* withFetch(
        (request) => {
          const pathname = new URL(request.url).pathname
          if (pathname === "/hold-first") return stalledResponse(firstStarted.resolve, firstCanceled.resolve)
          if (pathname === "/hold-second") return stalledResponse(secondStarted.resolve, secondCanceled.resolve)
          return new Response("fast", { headers: { "content-type": "text/plain" } })
        },
        (url) =>
          Effect.gen(function* () {
            const first = yield* exec(
              { url: new URL("/hold-first", url).toString(), format: "text" },
              context("ses_webfetch_abort", controller.signal),
            ).pipe(Effect.forkChild)
            const second = yield* exec(
              { url: new URL("/hold-second", url).toString(), format: "text" },
              context("ses_webfetch_held"),
            ).pipe(Effect.forkChild)

            yield* Effect.gen(function* () {
              yield* awaitWithTimeout(
                Effect.promise(() => Promise.all([firstStarted.promise, secondStarted.promise])),
                "two response bodies did not start",
              )
              controller.abort()

              const exit = yield* awaitWithTimeout(Fiber.await(first), "aborted webfetch did not finish")
              expectFailure(exit, "AbortError")
              yield* awaitWithTimeout(
                Effect.promise(() => firstCanceled.promise),
                "aborted response body was not canceled",
              )

              const result = yield* awaitWithTimeout(
                exec(
                  { url: new URL("/fast", url).toString(), format: "text", timeout: 1 },
                  context("ses_webfetch_after_abort"),
                ),
                "released permit did not admit the next webfetch",
              )
              expect(result.output).toBe("fast")
            }).pipe(Effect.ensuring(Effect.all([Fiber.interrupt(first), Fiber.interrupt(second)], { discard: true })))
          }),
      )
    }),
  )
})
