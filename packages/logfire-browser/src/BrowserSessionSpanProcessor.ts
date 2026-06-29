import type { Context } from '@opentelemetry/api'
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-web'

import type { BrowserSessionManager } from './browserSession'

const ATTR_SESSION_ID = 'session.id'
const ATTR_BROWSER_SESSION_ID = 'browser.session.id'
const ATTR_URL_FULL = 'url.full'
const ATTR_URL_PATH = 'url.path'

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

export class BrowserSessionSpanProcessor implements SpanProcessor {
  private readonly sessionManager: BrowserSessionManager

  constructor(sessionManager: BrowserSessionManager) {
    this.sessionManager = sessionManager
  }

  async forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  onEnd(_span: ReadableSpan): void {
    return undefined
  }

  onStart(span: Span, _parentContext: Context): void {
    const session = this.sessionManager.touch()
    span.setAttribute(ATTR_SESSION_ID, session.id)
    span.setAttribute(ATTR_BROWSER_SESSION_ID, session.id)

    const url = getCurrentUrl()
    if (url === undefined) {
      return
    }

    let urlAttributes: ReturnType<BrowserSessionManager['getUrlAttributes']>
    try {
      urlAttributes = this.sessionManager.getUrlAttributes(url)
    } catch {
      return
    }

    if (urlAttributes?.full !== undefined) {
      span.setAttribute(ATTR_URL_FULL, urlAttributes.full)
    }
    if (urlAttributes?.path !== undefined) {
      span.setAttribute(ATTR_URL_PATH, urlAttributes.path)
    }
  }

  async shutdown(): Promise<void> {
    return Promise.resolve()
  }
}
