import { describe, expect, test } from "bun:test"
import { detectServerProfile, supportsDurableSessionInput } from "../../src/context/server-profile"

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

describe("TUI server profile", () => {
  test("keeps a capable legacy server on V1 and enables only its advertised capability", async () => {
    const profile = await detectServerProfile({
      url: "http://test",
      fetch: ((input: RequestInfo | URL) => {
        const path = new URL(input instanceof Request ? input.url : input).pathname
        if (path === "/global/health") return Promise.resolve(json({ healthy: true, capabilities: { durableSessionInput: 1 } }))
        return Promise.resolve(json({ healthy: true, pid: 123 }))
      }) as typeof fetch,
    })

    expect(profile).toEqual({ protocol: "v1", capabilities: { durableSessionInput: 1 } })
    expect(supportsDurableSessionInput(profile)).toBe(true)
  })

  test("does not trust malformed legacy capability values", async () => {
    const profile = await detectServerProfile({
      url: "http://test",
      fetch: (() => Promise.resolve(json({ healthy: true, capabilities: { durableSessionInput: "1" } }))) as unknown as typeof fetch,
    })

    expect(profile).toEqual({ protocol: "v1", capabilities: {} })
    expect(supportsDurableSessionInput(profile)).toBe(false)
  })

  test("uses durable input for native V2 when legacy health is unavailable", async () => {
    const profile = await detectServerProfile({
      url: "http://test",
      fetch: ((input: RequestInfo | URL) => {
        const path = new URL(input instanceof Request ? input.url : input).pathname
        if (path === "/global/health") return Promise.resolve(json({}, 404))
        return Promise.resolve(json({ healthy: true, pid: 123 }))
      }) as typeof fetch,
    })

    expect(profile).toEqual({ protocol: "v2", capabilities: {} })
    expect(supportsDurableSessionInput(profile)).toBe(true)
  })
})
