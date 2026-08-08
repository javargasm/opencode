import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { createConnection, createServer } from "net"

const HOST = "127.0.0.1"
const MAX_RESPONSE_BYTES = 64

export type ProbeResult = "alive" | "ended" | "unknown"

export interface Interface {
  readonly incarnationID: string
  readonly port: number
  readonly probe: (input: { incarnationID: string; port: number }) => Effect.Effect<ProbeResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProcessIncarnation") {}

export function make(options?: { incarnationID?: string; probeTimeoutMillis?: number }) {
  return Effect.gen(function* () {
    const incarnationID = options?.incarnationID ?? crypto.randomUUID()
    const probeTimeoutMillis = options?.probeTimeoutMillis ?? 100
    const server = createServer((socket) => {
      socket.on("error", () => socket.destroy())
      socket.end(incarnationID)
    })
    yield* Effect.callback<void>((resume) => {
      const onError = (error: Error) => resume(Effect.die(error))
      server.once("error", onError)
      server.listen(0, HOST, () => {
        server.off("error", onError)
        resume(Effect.void)
      })
      return Effect.sync(() => {
        if (server.listening) server.close()
      })
    })
    yield* Effect.addFinalizer(() => close(server))
    const address = server.address()
    if (!address || typeof address === "string") return yield* Effect.die("Process incarnation did not bind a port")

    const probe: Interface["probe"] = Effect.fn("ProcessIncarnation.probe")((input) =>
      Effect.promise(() => probePort(input, probeTimeoutMillis)),
    )
    return Service.of({ incarnationID, port: address.port, probe })
  })
}

function probePort(input: { incarnationID: string; port: number }, timeoutMillis: number) {
  return new Promise<ProbeResult>((resolve) => {
    let settled = false
    let response = ""
    let socket: ReturnType<typeof createConnection> | undefined
    const finish = (result: ProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket?.destroy()
      resolve(result)
    }
    const timeout = setTimeout(() => finish("unknown"), timeoutMillis)
    try {
      socket = createConnection({ host: HOST, port: input.port })
    } catch {
      finish("unknown")
      return
    }
    socket.setEncoding("utf8")
    socket.on("data", (chunk) => {
      response += chunk
      if (Buffer.byteLength(response) > MAX_RESPONSE_BYTES) finish("unknown")
    })
    socket.once("end", () => {
      if (response === input.incarnationID) return finish("alive")
      finish(validIncarnationID(response) ? "ended" : "unknown")
    })
    socket.once("error", (error) => finish(refused(error) ? "ended" : "unknown"))
  })
}

function validIncarnationID(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function refused(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ECONNREFUSED"
}

function close(server: ReturnType<typeof createServer>) {
  if (!server.listening) return Effect.void
  return Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void))
  })
}

export const layer = Layer.effect(Service, make())

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as ProcessIncarnation from "./process-incarnation"
