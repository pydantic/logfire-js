export const WEB_VITAL_COMPONENT_ATTRIBUTE = 'data-logfire-component'

// The selector that web-vitals generates has the same limit.
const MAX_TARGET_LENGTH = 100
const TARGET_PREFIX = 'component:'
const NAMED_ELEMENT_SELECTOR = `[${WEB_VITAL_COMPONENT_ATTRIBUTE}]:not([${WEB_VITAL_COMPONENT_ATTRIBUTE}=""])`

/**
 * Names a Web Vital target after the nearest element that carries
 * `data-logfire-component`. It returns `undefined` for an element with no named
 * ancestor, so web-vitals falls back to its own CSS selector.
 */
export function generateComponentTarget(node: Node | null): string | undefined {
  try {
    // A layout shift source can be a text node.
    const element = node?.nodeType === 1 ? (node as Element) : node?.parentElement
    const name = element?.closest(NAMED_ELEMENT_SELECTOR)?.getAttribute(WEB_VITAL_COMPONENT_ATTRIBUTE)?.trim()
    if (name === undefined || name === '') {
      return undefined
    }
    return `${TARGET_PREFIX}${name}`.slice(0, MAX_TARGET_LENGTH)
  } catch {
    // A failed lookup must not suppress the selector fallback.
    return undefined
  }
}
