import { describe, expect, test } from "bun:test"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createEffect, createRoot } from "solid-js"
import type { Platform } from "@/context/platform"
import { createPromptReady, createPromptSession } from "@/context/prompt-state"
import { ServerScope } from "@/utils/server-scope"
import { createDraftStore } from "@/utils/draft-store"

let read: ((value: string | null) => void) | undefined

async function flushMicrotasks() {
  for (const _ of Array.from({ length: 8 })) await Promise.resolve()
}

const storage: AsyncStorage = {
  getItem: () => new Promise((resolve) => (read = resolve)),
  setItem: async () => undefined,
  removeItem: async () => undefined,
  clear: async () => undefined,
  key: async () => null,
  getLength: async () => 0,
  length: Promise.resolve(0),
}

const platform: Platform = {
  platform: "web",
  openExternal: () => undefined,
  restart: async () => undefined,
  notify: async () => undefined,
  draftStore: {
    ...storage,
    putBlob: async () => {
      throw new Error("putBlob is not used by this test")
    },
  },
}

describe("prompt persistence", () => {
  test("waits for an async draft to hydrate before reporting ready", async () => {
    await new Promise<void>((resolve, reject) => {
      createRoot((dispose) => {
        const session = createPromptSession(ServerScope.local, { draftID: "draft-async" }, undefined, platform)
        const ready = createPromptReady(() => session)

        expect(ready()).toBe(false)
        expect(session.current()[0]).toMatchObject({ type: "text", content: "" })

        read?.(
          JSON.stringify({
            prompt: [{ type: "text", content: "persisted draft", start: 0, end: 15 }],
            cursor: 15,
            context: { items: [] },
          }),
        )

        createEffect(() => {
          if (!ready()) return
          try {
            expect(session.current()[0]).toMatchObject({ type: "text", content: "persisted draft" })
            dispose()
            resolve()
          } catch (error) {
            dispose()
            reject(error)
          }
        })
      })
    })
  })
})

test("moves legacy image data URLs into blobs and hydrates object URLs", async () => {
  const documents = new Map<string, string>()
  const blobs = new Map<string, Blob>()
  const store = createDraftStore({
    get: async (key) => documents.get(key) ?? null,
    set: async (key, value) => void documents.set(key, value),
    remove: async (key) => void documents.delete(key),
    putBlob: async (blob) => {
      const id = String(blob.size)
      blobs.set(id, blob)
      return id
    },
    getBlob: async (id) => blobs.get(id) ?? null,
  })

  await store.setItem("prompt", JSON.stringify({ prompt: [{ type: "image", dataUrl: "data:image/png;base64,YQ==" }] }))
  expect(documents.get("prompt")).not.toContain("dataUrl")
  const value = JSON.parse((await store.getItem("prompt"))!)
  expect(value.prompt[0].blob.id).toBe("1")
  expect(value.prompt[0].blob.url).toStartWith("blob:")
})

test("persists stash image references without their transient object URLs", async () => {
  const documents = new Map<string, string>()
  const blobs = new Map<string, Blob>()
  const store = createDraftStore({
    get: async (key) => documents.get(key) ?? null,
    set: async (key, value) => void documents.set(key, value),
    remove: async (key) => void documents.delete(key),
    putBlob: async (blob) => {
      blobs.set("stash-image", blob)
      return "stash-image"
    },
    getBlob: async (id) => blobs.get(id) ?? null,
  })
  const blob = await store.putBlob(new Blob(["stash image"], { type: "image/png" }))

  await store.setItem(
    "prompt.stash",
    JSON.stringify({
      entries: [
        {
          id: "stash",
          input: "",
          timestamp: 1,
          parts: [{ type: "image", id: "image", filename: "image.png", mime: "image/png", blob }],
        },
      ],
    }),
  )

  const raw = JSON.parse(documents.get("prompt.stash")!)
  expect(raw.entries[0].parts[0].blob).toEqual({ id: "stash-image" })

  const restored = JSON.parse((await store.getItem("prompt.stash"))!)
  expect(restored.entries[0].parts[0].blob).toMatchObject({ id: "stash-image", url: expect.stringMatching(/^blob:/) })
})

test("does not let delayed blob migration overwrite a newer draft", async () => {
  const documents = new Map<string, string>()
  const migration = Promise.withResolvers<void>()
  const store = createDraftStore({
    get: async () => null,
    set: async (key, value) => void documents.set(key, value),
    remove: async () => undefined,
    putBlob: async () => {
      await migration.promise
      return "blob"
    },
    getBlob: async () => null,
  })
  const older = store.setItem(
    "prompt",
    JSON.stringify({ prompt: [{ type: "image", dataUrl: "data:image/png;base64,YQ==" }] }),
  )
  await Bun.sleep(0)
  await store.setItem("prompt", JSON.stringify({ prompt: [{ type: "text", content: "latest" }] }))
  migration.resolve()
  await older

  expect(documents.get("prompt")).toContain("latest")
})

test("does not let a delayed write overwrite a later write", async () => {
  const documents = new Map<string, string>()
  const writeStarted = Promise.withResolvers<void>()
  const releaseWrite = Promise.withResolvers<void>()
  const store = createDraftStore({
    get: async (key) => documents.get(key) ?? null,
    set: async (key, value) => {
      if (value === JSON.stringify({ value: "old" })) {
        writeStarted.resolve()
        await releaseWrite.promise
      }
      documents.set(key, value)
    },
    remove: async (key) => void documents.delete(key),
    putBlob: async () => "unused",
    getBlob: async () => null,
  })

  const old = store.setItem("draft", JSON.stringify({ value: "old" }))
  await writeStarted.promise
  const latest = store.setItem("draft", JSON.stringify({ value: "latest" }))
  await flushMicrotasks()
  releaseWrite.resolve()
  await Promise.all([old, latest])

  expect(documents.get("draft")).toBe(JSON.stringify({ value: "latest" }))
})

test("does not let a delayed write restore a removed draft", async () => {
  const documents = new Map<string, string>()
  const writeStarted = Promise.withResolvers<void>()
  const releaseWrite = Promise.withResolvers<void>()
  const store = createDraftStore({
    get: async (key) => documents.get(key) ?? null,
    set: async (key, value) => {
      if (value === JSON.stringify({ value: "old" })) {
        writeStarted.resolve()
        await releaseWrite.promise
      }
      documents.set(key, value)
    },
    remove: async (key) => void documents.delete(key),
    putBlob: async () => "unused",
    getBlob: async () => null,
  })

  const old = store.setItem("draft", JSON.stringify({ value: "old" }))
  await writeStarted.promise
  const remove = store.removeItem("draft")
  await flushMicrotasks()
  releaseWrite.resolve()
  await Promise.all([old, remove])

  expect(documents.has("draft")).toBe(false)
})

test("does not let a delayed removal delete a later write", async () => {
  const documents = new Map<string, string>([["draft", JSON.stringify({ value: "old" })]])
  const removeStarted = Promise.withResolvers<void>()
  const releaseRemove = Promise.withResolvers<void>()
  const store = createDraftStore({
    get: async (key) => documents.get(key) ?? null,
    set: async (key, value) => void documents.set(key, value),
    remove: async (key) => {
      removeStarted.resolve()
      await releaseRemove.promise
      documents.delete(key)
    },
    putBlob: async () => "unused",
    getBlob: async () => null,
  })

  const old = store.removeItem("draft")
  await removeStarted.promise
  const latest = store.setItem("draft", JSON.stringify({ value: "latest" }))
  await flushMicrotasks()
  releaseRemove.resolve()
  await Promise.all([old, latest])

  expect(documents.get("draft")).toBe(JSON.stringify({ value: "latest" }))
})
