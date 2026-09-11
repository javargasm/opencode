export function hasCustomAgent(items: Array<{ native?: boolean }>) {
  return items.some((item) => item.native === false)
}

export function isAgentSelectorVisible(preference: boolean, items: Array<{ native?: boolean }>) {
  return preference || hasCustomAgent(items) || items.length > 1
}

export function resolveAgent<T extends { name: string }>(items: T[], name?: string) {
  return items.find((item) => item.name === name) ?? items.find((item) => item.name === "build") ?? items[0]
}
