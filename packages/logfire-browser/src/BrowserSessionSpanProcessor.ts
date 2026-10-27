import type { Attributes, Context } from '@opentelemetry/api'
import { INTERACTION_CONTEXT } from './interactionContext'
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-web'

import type { BrowserSessionManager, BrowserSessionState } from './browserSession'
import type { BrowserSessionReplayState } from './sessionReplay'

const ATTR_SESSION_ID = 'session.id'
const ATTR_SESSION_REPLAY_ACTIVE = 'logfire.session_replay.active'
const ATTR_SESSION_REPLAY_MODE = 'logfire.session_replay.mode'
const ATTR_SESSION_REPLAY_ID = 'logfire.session_replay.id'
const ATTR_LOGFIRE_PAGE_ROUTE = 'logfire.page.route'
const ATTR_LOGFIRE_PAGE_URL_FULL = 'logfire.page.url.full'
const ATTR_LOGFIRE_PAGE_URL_PATH = 'logfire.page.url.path'
const ATTR_USER_EMAIL = 'user.email'
const ATTR_USER_ID = 'user.id'
const ATTR_USER_NAME = 'user.name'
const LONG_ANIMATION_FRAME_TRACER_NAME = 'logfire-long-animation-frames'
const MAIN_THREAD_WINDOW_SPAN_NAME = 'browser.main_thread_window'
const WEB_VITALS_TRACER_NAME = 'logfire-web-vitals'

function getCurrentUrl(): URL | undefined {
  const maybeGlobal = globalThis as {
    location?: { href?: string }
    window?: { location?: { href?: string } }
  }

  try {
    const location = maybeGlobal.location ?? maybeGlobal.window?.location
    const href = location?.href
    if (href === undefined || href === '') {
      return undefined
    }
    return new URL(href)
  } catch {
    return undefined
  }
}

function getIdentityAttributes(
  sessionManager: BrowserSessionManager,
  replayState: BrowserSessionReplayState | undefined,
  session: BrowserSessionState
): Attributes {
  const attributes: Attributes = { [ATTR_SESSION_ID]: session.id }
  for (const [key, value] of Object.entries(session.sessionAttributes ?? {})) {
    attributes[`logfire.session.${key}`] = value
  }

  let state: ReturnType<BrowserSessionReplayState['getState']>
  try {
    state = replayState?.getState()
  } catch {
    state = undefined
  }
  if (state !== undefined) {
    attributes[ATTR_SESSION_REPLAY_ACTIVE] = state.active
    attributes[ATTR_SESSION_REPLAY_MODE] = state.mode
    if (state.recordingId !== undefined) {
      attributes[ATTR_SESSION_REPLAY_ID] = state.recordingId
    }
  }

  const user = sessionManager.getUser()
  if (user !== undefined) {
    attributes[ATTR_USER_ID] = user.id
    if (user.name !== undefined) {
      attributes[ATTR_USER_NAME] = user.name
    }
    if (user.email !== undefined) {
      attributes[ATTR_USER_EMAIL] = user.email
    }
  }
  return attributes
}

function getPageAttributes(sessionManager: BrowserSessionManager, url: URL | undefined): Attributes {
  const attributes: Attributes = {}
  const routeName = sessionManager.getRouteName(url)
  if (routeName !== undefined) {
    attributes[ATTR_LOGFIRE_PAGE_ROUTE] = routeName
  }

  if (url === undefined) {
    return attributes
  }

  let urlAttributes: ReturnType<BrowserSessionManager['getUrlAttributes']>
  try {
    urlAttributes = sessionManager.getUrlAttributes(url)
  } catch {
    urlAttributes = undefined
  }

  if (urlAttributes?.full !== undefined) {
    attributes[ATTR_LOGFIRE_PAGE_URL_FULL] = urlAttributes.full
  }
  if (urlAttributes?.path !== undefined) {
    attributes[ATTR_LOGFIRE_PAGE_URL_PATH] = urlAttributes.path
  }
  return attributes
}

/** The attributes `BrowserSessionSpanProcessor` would add now, for spans that report this moment later. */
export function snapshotBrowserSpanAttributes(
  sessionManager: BrowserSessionManager,
  replayState: BrowserSessionReplayState | undefined,
  session: BrowserSessionState
): Attributes {
  return { ...getIdentityAttributes(sessionManager, replayState, session), ...getPageAttributes(sessionManager, getCurrentUrl()) }
}

export class BrowserSessionSpanProcessor implements SpanProcessor {
  private readonly replayState: BrowserSessionReplayState | undefined
  private readonly sessionManager: BrowserSessionManager

  constructor(sessionManager: BrowserSessionManager, replayState?: BrowserSessionReplayState) {
    this.sessionManager = sessionManager
    this.replayState = replayState
  }

  async forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  onEnd(_span: ReadableSpan): void {
    return undefined
  }

  onStart(span: Span, parentContext: Context): void {
    const interaction = parentContext.getValue(INTERACTION_CONTEXT) as Attributes | undefined
    if (interaction !== undefined) {
      span.setAttributes(interaction)
      return
    }
    const isPeriodicMainThreadWindow =
      span.instrumentationScope.name === LONG_ANIMATION_FRAME_TRACER_NAME && span.name === MAIN_THREAD_WINDOW_SPAN_NAME
    const session = isPeriodicMainThreadWindow ? this.sessionManager.getSession() : this.sessionManager.touch()
    span.setAttributes(getIdentityAttributes(this.sessionManager, this.replayState, session))

    // Web Vital callbacks can run after a later navigation. Their reporter
    // applies the metric's navigation URL instead of callback-time page state.
    if (span.instrumentationScope.name === WEB_VITALS_TRACER_NAME && span.name.startsWith('web_vital.')) {
      return
    }

    span.setAttributes(getPageAttributes(this.sessionManager, getCurrentUrl()))
  }

  async shutdown(): Promise<void> {
    return Promise.resolve()
  }
}
