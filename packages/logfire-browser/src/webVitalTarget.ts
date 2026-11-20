import { generateStableSelector, getSelector } from './webVitalSelector'

export const WEB_VITAL_COMPONENT_ATTRIBUTE = 'data-logfire-component'

// The selector that web-vitals generates has the same limit.
const MAX_TARGET_LENGTH = 100
const TARGET_PREFIX = 'component:'
// web-vitals carries one string for each target, so the selector follows the component name after a separator.
const SELECTOR_SEPARATOR = '\n'
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

function generateDefaultTargetWith(node: Node | null, stableSelectors: boolean): string | undefined {
  // A line break in a name would be read as the separator.
  const target = generateComponentTarget(node)?.split(SELECTOR_SEPARATOR).join(' ')
  if (target === undefined) {
    return stableSelectors ? generateStableSelector(node) : undefined
  }
  const selector = getSelector(node, stableSelectors)
  return selector === '' ? target : `${target}${SELECTOR_SEPARATOR}${selector}`
}

/**
 * The default `generateTarget`. A component name carries the CSS selector of
 * the element after a separator; `splitWebVitalTarget` takes the two apart.
 */
export function generateDefaultTarget(node: Node | null): string | undefined {
  return generateDefaultTargetWith(node, false)
}

/** The default `generateTarget` when `stableSelectors` is on. */
export function generateStableDefaultTarget(node: Node | null): string | undefined {
  return generateDefaultTargetWith(node, true)
}

// The value is `unknown` because a custom `generateTarget` in JavaScript can return any type.
export function splitWebVitalTarget(value: unknown): { selector?: string; target: unknown } {
  const separatorIndex = typeof value === 'string' && value.startsWith(TARGET_PREFIX) ? value.indexOf(SELECTOR_SEPARATOR) : -1
  if (typeof value !== 'string' || separatorIndex === -1) {
    return { target: value }
  }
  return { selector: value.slice(separatorIndex + 1), target: value.slice(0, separatorIndex) }
}
