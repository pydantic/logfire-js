import { createContextKey } from '@opentelemetry/api'

/** Internal frozen attributes for delayed browser diagnostics; never read callback-time identity. */
export const INTERACTION_CONTEXT: symbol = createContextKey('logfire.browser.interaction-context')
