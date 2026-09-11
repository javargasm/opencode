import { afterEach, expect, test } from "bun:test"
import { findWorkspaceHealthFooterMount, WORKSPACE_HEALTH_FOOTER_MOUNT_ID } from "./workspace-health-footer"

afterEach(() => document.body.replaceChildren())

test("finds the layout footer mount", () => {
  const mount = document.createElement("div")
  mount.id = WORKSPACE_HEALTH_FOOTER_MOUNT_ID
  document.body.append(mount)

  expect(findWorkspaceHealthFooterMount(document)).toBe(mount)
})
