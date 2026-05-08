import Handlebars from 'handlebars'

import { createSafeHandlebarsContext } from './template'

export const HAS_REFERENCE: RegExp = /(?<!\\)@\{/
export const REFERENCE_TAG: RegExp = /(?<!\\)@\{(.*?)\}@/g
export const SIMPLE_REF: RegExp = /(?<!\\)@\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\}@/g
export const BLOCK_REF: RegExp = /(?<!\\)@\{#\w+\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s|\}@)/g

let sentinelCounter = 0

export function renderOnce(template: string, context: Record<string, unknown>): string {
  const unique = `${Date.now().toString(36)}-${(sentinelCounter++).toString(36)}`
  const leftRuntimePlaceholder = `LOGFIRE_LEFT_RUNTIME_PLACEHOLDER_${unique}_LOGFIRE`
  const rightRuntimePlaceholder = `LOGFIRE_RIGHT_RUNTIME_PLACEHOLDER_${unique}_LOGFIRE`
  const escapedReferenceStart = `LOGFIRE_ESCAPED_REFERENCE_START_${unique}_LOGFIRE`

  const protectedTemplate = template
    .replaceAll('\\@{', escapedReferenceStart)
    .replaceAll('{{', leftRuntimePlaceholder)
    .replaceAll('}}', rightRuntimePlaceholder)
  const handlebarsTemplate = protectedTemplate.replace(REFERENCE_TAG, '{{$1}}')
  const rendered = Handlebars.compile(handlebarsTemplate)(createSafeHandlebarsContext(context))
  return rendered.replaceAll(leftRuntimePlaceholder, '{{').replaceAll(rightRuntimePlaceholder, '}}').replaceAll(escapedReferenceStart, '@{')
}
