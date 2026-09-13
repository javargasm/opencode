import { describe, expect, test } from "bun:test"
import { detectServerProfile, detectServerProtocol } from "./server-protocol"

const server = { url: "http://localhost:4096" }
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
const mockFetch = (run: (input: string | URL | Request) => Promise<Response>) =>
  Object.assign(run, { preconnect: globalThis.fetch.preconnect })

describe("detectServerProtocol", () => {
  test("prefers the legacy health endpoint when both API generations exist", async () => {
    const fetcher = mockFetch((input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/global/health") return Promise.resolve(json({ healthy: true, version: "1.18.4" }))
      return Promise.resolve(json({ healthy: true, version: "2.0.0", pid: 123 }))
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v1")
  })

  test("recognizes V2 health by its process identifier", async () => {
    const fetcher = mockFetch((input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/global/health") return Promise.resolve(json({}, 404))
      return Promise.resolve(json({ healthy: true, version: "2.0.0", pid: 123 }))
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v2")
  })

  test("recognizes the transitional V1 API health response", async () => {
    const fetcher = mockFetch((input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/global/health") return Promise.resolve(json({}, 404))
      return Promise.resolve(json({ healthy: true }))
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v1")
  })

  test("keeps a capable legacy server on V1 while preserving its durable input capability", async () => {
    const fetcher = mockFetch((input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/global/health")
        return Promise.resolve(json({ healthy: true, capabilities: { durableSessionInput: 1 } }))
      return Promise.resolve(json({ healthy: true, pid: 123 }))
    })

    expect(await detectServerProfile(server, fetcher)).toEqual({
      protocol: "v1",
      capabilities: { durableSessionInput: 1 },
    })
    expect(await detectServerProtocol(server, fetcher)).toBe("v1")
  })

  test("does not enable durable input for malformed legacy capability values", async () => {
    for (const value of [0, "1", 2, true, undefined]) {
      const fetcher = mockFetch((input) => {
        const path = new URL(input instanceof Request ? input.url : input).pathname
        if (path === "/global/health")
          return Promise.resolve(json({ healthy: true, capabilities: { durableSessionInput: value } }))
        return Promise.resolve(json({}, 404))
      })

      expect(await detectServerProfile(server, fetcher)).toEqual({ protocol: "v1", capabilities: {} })
    }
  })
})
