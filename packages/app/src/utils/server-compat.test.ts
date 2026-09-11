import { describe, expect, test } from "bun:test"
import { createApiForServer, createSdkForServer } from "./server"
import { createCompatibleApi } from "./server-compat"

function setup(
  protocol: "v1" | "v2" | Promise<"v1" | "v2">,
  responses?: { vcs?: { branch: string; default_branch: string } },
) {
  const requests: Request[] = []
  const fetcher = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.method === "PATCH") {
        return Response.json({
          id: "ses_1",
          slug: "ses_1",
          projectID: "project",
          directory: "/repo",
          title: "Session",
          version: "1",
          time: { created: 1, updated: 1 },
        })
      }
      if (request.method === "POST" && new URL(request.url).pathname === "/session") {
        const body = (await request.clone().json().catch(() => ({}))) as Record<string, any>
        return Response.json({
          id: "ses_1",
          slug: "ses_1",
          projectID: "project",
          directory: "/repo",
          title: body.title ?? "Session",
          parentID: body.parentID,
          agent: body.agent,
          model: body.model,
          version: "1",
          time: { created: 1, updated: 1 },
        })
      }
      if (request.method === "POST" && request.url.endsWith("/prompt_async"))
        return new Response(undefined, { status: 204 })
      if (request.method === "POST" && request.url.endsWith("/prompt")) {
        return Response.json({
          admittedSeq: 1,
          id: "msg_1",
          sessionID: "ses_1",
          timeCreated: 1,
          type: "user",
          data: { text: "hello" },
          delivery: "steer",
        })
      }
      if (request.method === "GET" && new URL(request.url).pathname === "/vcs")
        return Response.json(responses?.vcs ?? {})
      if (request.method === "GET") return Response.json([])
      return new Response(undefined, { status: 204 })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const server = { url: "http://localhost:4096" }
  const api = createCompatibleApi({
    protocol: typeof protocol === "string" ? Promise.resolve(protocol) : protocol,
    current: createApiForServer({ server, fetch: fetcher }),
    legacy: (directory) => createSdkForServer({ server, fetch: fetcher, directory, throwOnError: true }),
    directory: "/repo",
  })
  return { api, requests }
}

describe("createCompatibleApi", () => {
  /*
  test("routes V1 archive through the legacy session update", async () => {
    const { api, requests } = setup("v1")
    await api.session.archive({ sessionID: "ses_1", directory: "/repo" })

    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe("/session/ses_1")
    expect(requests[0]!.headers.get("x-opencode-directory")).toBe("%2Frepo")
    expect(requests[0]!.method).toBe("PATCH")
    expect(await requests[0]!.json()).toMatchObject({ time: { archived: expect.any(Number) } })
  })
  */

  test("routes V1 rename through the legacy session update", async () => {
    const { api, requests } = setup("v1")
    await api.session.rename({ sessionID: "ses_1", title: "Renamed V1" })

    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(new URL(request.url).pathname).toBe("/session/ses_1")
    expect(request.method).toBe("PATCH")
    expect(await request.json()).toMatchObject({ title: "Renamed V1" })
  })

  test("routes V1 remove through the legacy session delete", async () => {
    const { api, requests } = setup("v1")
    await api.session.remove({ sessionID: "ses_1" })

    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(new URL(request.url).pathname).toBe("/session/ses_1")
    expect(request.method).toBe("DELETE")
  })

  test("converts current prompts to the V1 prompt contract", async () => {
    const { api, requests } = setup("v1")
    await api.session.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "hello @src/index.ts",
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      files: [
        { uri: "file:///repo/src/index.ts", name: "index.ts", mention: { text: "@src/index.ts", start: 6, end: 19 } },
        { uri: "data:text/plain;base64,aGVsbG8=", name: "notes.txt" },
      ],
    })

    expect(new URL(requests[0]!.url).pathname).toBe("/session/ses_1/prompt_async")
    const body = await requests[0]!.json()
    expect(body).toMatchObject({
      messageID: "msg_1",
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      parts: [
        { type: "text", text: "hello @src/index.ts" },
        {
          type: "file",
          mime: "text/plain",
          url: "file:///repo/src/index.ts",
          filename: "index.ts",
          source: {
            type: "file",
            text: { value: "@src/index.ts", start: 6, end: 19 },
            path: "file:///repo/src/index.ts",
          },
        },
        {
          type: "file",
          mime: "text/plain",
          url: "data:text/plain;base64,aGVsbG8=",
          filename: "notes.txt",
        },
      ],
    })
    expect(body.parts[2]).not.toHaveProperty("source")
  })

  test("preserves original parts for V1 optimistic reconciliation", async () => {
    const { api, requests } = setup("v1")
    await api.session.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "look",
      files: [{ uri: "data:image/png;base64,AAAA", name: "image.png" }],
      legacyParts: [
        { id: "prt_text", type: "text", text: "look" },
        { id: "prt_image", type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "image.png" },
      ],
    })

    expect((await requests[0]!.json()).parts).toEqual([
      { id: "prt_text", type: "text", text: "look" },
      { id: "prt_image", type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "image.png" },
    ])
  })

  test("resolves protocol detection once across implementation methods", async () => {
    let detections = 0
    const resolved = Promise.resolve<"v1" | "v2">("v2")
    const protocol = new Proxy(resolved, {
      get(target, property) {
        if (property !== "then") return Reflect.get(target, property, target)
        detections++
        return target.then.bind(target)
      },
    })
    const { api } = setup(protocol)

    await api.session.list()
    await api.session.list()

    expect(detections).toBe(1)
  })

  test("uses legacy summarize for V2 compaction until the V2 endpoint is implemented", async () => {
    const { api, requests } = setup("v2")

    await api.session.compact({
      sessionID: "ses_1",
      model: { providerID: "provider", modelID: "model" },
    })

    expect(requests).toHaveLength(1)
    const request = requests[0]
    if (!request) throw new Error("Expected a summarize request")
    expect(new URL(request.url).pathname).toBe("/session/ses_1/summarize")
    expect(request.method).toBe("POST")
    expect(await request.json()).toEqual({ providerID: "provider", modelID: "model" })
  })

  test("uses legacy session update for V2 rename until the V2 endpoint is implemented", async () => {
    const { api, requests } = setup("v2")

    await api.session.rename({ sessionID: "ses_1", title: "Renamed Session" })

    expect(requests).toHaveLength(1)
    const request = requests[0]
    if (!request) throw new Error("Expected a rename request")
    expect(new URL(request.url).pathname).toBe("/session/ses_1")
    expect(request.method).toBe("PATCH")
    expect(await request.json()).toMatchObject({ title: "Renamed Session" })
  })

  test("uses legacy session delete for V2 remove until the V2 endpoint is implemented", async () => {
    const { api, requests } = setup("v2")

    await api.session.remove({ sessionID: "ses_1" })

    expect(requests).toHaveLength(1)
    const request = requests[0]
    if (!request) throw new Error("Expected a remove request")
    expect(new URL(request.url).pathname).toBe("/session/ses_1")
    expect(request.method).toBe("DELETE")
  })

  /*
  test("keeps V2 session actions on the current API", async () => {
    const { api, requests } = setup("v2")
    await api.session.archive({ sessionID: "ses_1" })

    expect(new URL(requests[0]!.url).pathname).toBe("/api/session/ses_1/archive")
    expect(requests[0]!.method).toBe("POST")
  })
  */

  test("uses the global V1 session search endpoint", async () => {
    const { api, requests } = setup("v1")
    await api.session.list({ parentID: null, search: "session", limit: 50 })

    expect(new URL(requests[0]!.url).pathname).toBe("/experimental/session")
  })

  /*
  test("projects the V1 default branch", async () => {
    const { api } = setup("v1", { vcs: { branch: "feature", default_branch: "dev" } })

    expect(await api.vcs.get({ location: { directory: "/repo" } })).toMatchObject({
      data: { branch: "feature", defaultBranch: "dev" },
    })
  })
  */

  test("translates current file searches to the V1 dirs parameter", async () => {
    const { api, requests } = setup("v1")
    await api.file.find({ location: { directory: "/repo" }, query: "src", type: "file", limit: 20 })

    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe("/find/file")
    expect(url.searchParams.get("dirs")).toBe("false")
    expect(url.searchParams.get("limit")).toBe("20")
  })

  test("routes V1 permission replies through the requested directory", async () => {
    const { api, requests } = setup("v1")
    await api.permission.reply({
      sessionID: "ses_1",
      requestID: "permission_1",
      reply: "once",
      location: { directory: "/other" },
    })

    expect(new URL(requests[0]!.url).pathname).toBe("/session/ses_1/permissions/permission_1")
    expect(new URL(requests[0]!.url).searchParams.get("directory")).toBe("/other")
  })

  test("disposes the V1 instance after connecting a provider", async () => {
    const { api, requests } = setup("v1")

    await api.integration.connect.key({
      integrationID: "openrouter",
      key: "secret",
      location: { directory: "/repo" },
    })

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/auth/openrouter",
      "/instance/dispose",
      "/instance/dispose",
    ])
    expect(requests[1]!.headers.get("x-opencode-directory")).toBe("%2Frepo")
    expect(requests[2]!.headers.get("x-opencode-directory")).toBeNull()
  })

  test("disposes the V1 instance after completing provider OAuth", async () => {
    const { api, requests } = setup("v1")

    await api.integration.oauth.complete({
      integrationID: "openrouter",
      attemptID: "openrouter:0",
      code: "code",
      location: { directory: "/repo" },
    })

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/provider/openrouter/oauth/callback",
      "/instance/dispose",
      "/instance/dispose",
    ])
    expect(requests[1]!.headers.get("x-opencode-directory")).toBe("%2Frepo")
    expect(requests[2]!.headers.get("x-opencode-directory")).toBeNull()
  })

  test("forwards model, agent, parentID, and title when creating a session in V1", async () => {
    const { api, requests } = setup("v1")
    const session = await api.session.create({
      agent: "build",
      model: { id: "claude-3-7-sonnet", providerID: "anthropic", variant: "high" },
      parentID: "ses_parent",
      title: "Subagent session",
      location: { directory: "/repo" },
    })

    expect(new URL(requests[0]!.url).pathname).toBe("/session")
    expect(requests[0]!.method).toBe("POST")
    const body = await requests[0]!.json()
    expect(body).toEqual({
      parentID: "ses_parent",
      title: "Subagent session",
      agent: "build",
      model: {
        id: "claude-3-7-sonnet",
        providerID: "anthropic",
        variant: "high",
      },
    })
    expect(session.agent).toBe("build")
    expect(session.parentID).toBe("ses_parent")
    expect(session.model?.variant).toBe("high")
  })

  test("normalizes default variant to undefined in sessionInfo", async () => {
    const { api, requests } = setup("v1")
    const session = await api.session.create({
      agent: "build",
      model: { id: "gpt-4o", providerID: "openai", variant: "default" },
      location: { directory: "/repo" },
    })

    const body = await requests[0]!.json()
    expect(body.model.variant).toBeUndefined()
    expect(session.model?.variant).toBeUndefined()
  })
})
