import type { BrowserWebVitalsOptions } from './webVitals'

export const BROWSER_SESSION_ACTIVITY_WRITE_DELAY_MS = 1_000

export interface BrowserSessionUrlAttributes {
  full?: string
  path?: string
}

export interface BrowserSessionOptions {
  /**
   * Session inactivity timeout. Defaults to 30 minutes.
   */
  idleTimeoutMs?: number
  /**
   * Hard cap on one browser session. Defaults to 4 hours.
   */
  maxDurationMs?: number
  /**
   * Storage key for tests or advanced embedding. Defaults to
   * `lf_browser_session`.
   */
  storageKey?: string
  /**
   * Controls URL attributes stamped on session/RUM spans. Defaults to emitting
   * `url.full = window.location.origin + window.location.pathname` and
   * `url.path = window.location.pathname`. Set to false to suppress URL
   * attributes, or return custom values (including the raw URL if required).
   */
  urlAttributes?: false | ((url: URL) => BrowserSessionUrlAttributes)
}

export interface BrowserSessionState {
  id: string
  startedAt: number
  lastActivityAt: number
}

export interface RUMOptions {
  /**
   * Enable browser session identity and session/page span attributes.
   */
  session?: boolean | BrowserSessionOptions
  /**
   * Enable browser Web Vitals reporting.
   */
  webVitals?: boolean | BrowserWebVitalsOptions
}

export interface BrowserSessionManagerOptions extends BrowserSessionOptions {
  /**
   * Internal injection point for tests and unusual embedding environments.
   */
  storage?: Storage | null
  /**
   * Internal injection point for deterministic tests.
   */
  now?: () => number
  /**
   * Internal injection point for deterministic tests.
   */
  generateId?: () => string
}

export const DEFAULT_BROWSER_SESSION_OPTIONS: {
  idleTimeoutMs: number
  maxDurationMs: number
  storageKey: string
} = {
  idleTimeoutMs: 30 * 60_000,
  maxDurationMs: 4 * 60 * 60_000,
  storageKey: 'lf_browser_session',
}

function getDefaultSessionStorage(): Storage | null {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null
  } catch {
    return null
  }
}

function generateBrowserSessionId(): string {
  const cryptoApi = (globalThis as { crypto?: Crypto & { randomUUID?: () => string } }).crypto
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }

  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    cryptoApi.getRandomValues(bytes)
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

function isBrowserSessionState(value: unknown): value is BrowserSessionState {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const maybeSession = value as Partial<BrowserSessionState>
  return (
    typeof maybeSession.id === 'string' &&
    maybeSession.id.length > 0 &&
    typeof maybeSession.startedAt === 'number' &&
    Number.isFinite(maybeSession.startedAt) &&
    typeof maybeSession.lastActivityAt === 'number' &&
    Number.isFinite(maybeSession.lastActivityAt)
  )
}

export class BrowserSessionManager {
  private readonly generateId: () => string
  private readonly idleTimeoutMs: number
  private readonly maxDurationMs: number
  private readonly now: () => number
  private readonly storage: Storage | null
  private readonly storageKey: string
  private readonly urlAttributes: BrowserSessionOptions['urlAttributes'] | undefined
  private memorySession: BrowserSessionState | undefined
  private pendingSession: BrowserSessionState | undefined
  private persistenceTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: BrowserSessionManagerOptions = {}) {
    this.generateId = options.generateId ?? generateBrowserSessionId
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_BROWSER_SESSION_OPTIONS.idleTimeoutMs
    this.maxDurationMs = options.maxDurationMs ?? DEFAULT_BROWSER_SESSION_OPTIONS.maxDurationMs
    this.now = options.now ?? Date.now
    this.storage = options.storage === undefined ? getDefaultSessionStorage() : options.storage
    this.storageKey = options.storageKey ?? DEFAULT_BROWSER_SESSION_OPTIONS.storageKey
    this.urlAttributes = options.urlAttributes
  }

  getSession(): BrowserSessionState {
    return this.getSessionAt(this.now())
  }

  peekSessionId(): string | undefined {
    return this.memorySession?.id
  }

  touch(): BrowserSessionState {
    const now = this.now()
    const session = this.getSessionAt(now)
    const touchedSession = { ...session, lastActivityAt: now }
    this.memorySession = touchedSession
    this.scheduleWrite(touchedSession)
    return touchedSession
  }

  reset(): BrowserSessionState {
    return this.createSession(this.now())
  }

  flushPendingStorage(): void {
    if (this.persistenceTimer !== undefined) {
      clearTimeout(this.persistenceTimer)
      this.persistenceTimer = undefined
    }
    const pendingSession = this.pendingSession
    this.pendingSession = undefined
    if (pendingSession !== undefined) {
      this.writeSession(pendingSession)
    }
  }

  getUrlAttributes(url: URL): BrowserSessionUrlAttributes | undefined {
    if (this.urlAttributes === false) {
      return undefined
    }

    if (typeof this.urlAttributes === 'function') {
      return this.urlAttributes(url)
    }

    return {
      full: `${url.origin}${url.pathname}`,
      path: url.pathname,
    }
  }

  private createSession(now: number): BrowserSessionState {
    const session: BrowserSessionState = {
      id: this.generateId(),
      lastActivityAt: now,
      startedAt: now,
    }
    this.flushPendingStorage()
    this.writeSession(session)
    return session
  }

  private getSessionAt(now: number): BrowserSessionState {
    if (this.memorySession !== undefined && !this.isExpired(this.memorySession, now)) {
      return this.memorySession
    }
    const storedSession = this.readSession()
    if (storedSession !== undefined && !this.isExpired(storedSession, now)) {
      return storedSession
    }

    return this.createSession(now)
  }

  private isExpired(session: BrowserSessionState, now: number): boolean {
    return now - session.lastActivityAt > this.idleTimeoutMs || now - session.startedAt > this.maxDurationMs
  }

  private readSession(): BrowserSessionState | undefined {
    if (this.storage !== null) {
      try {
        const value = this.storage.getItem(this.storageKey)
        if (value !== null) {
          const parsedValue: unknown = JSON.parse(value)
          if (isBrowserSessionState(parsedValue)) {
            this.memorySession = parsedValue
            return parsedValue
          }
        }
      } catch {
        return this.memorySession
      }
    }

    return this.memorySession
  }

  private writeSession(session: BrowserSessionState): void {
    this.memorySession = session
    if (this.storage === null) {
      return
    }

    try {
      this.storage.setItem(this.storageKey, JSON.stringify(session))
    } catch {
      // Session identity is best-effort in constrained browser contexts.
    }
  }

  private scheduleWrite(session: BrowserSessionState): void {
    this.pendingSession = session
    if (this.persistenceTimer !== undefined) {
      return
    }
    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = undefined
      const pendingSession = this.pendingSession
      this.pendingSession = undefined
      if (pendingSession !== undefined) {
        this.writeSession(pendingSession)
      }
    }, BROWSER_SESSION_ACTIVITY_WRITE_DELAY_MS)
  }
}

let configuredBrowserSessionManager: BrowserSessionManager | undefined

export function configureBrowserSession(session: RUMOptions['session'] | undefined): BrowserSessionManager | undefined {
  configuredBrowserSessionManager?.flushPendingStorage()
  if (session === undefined || session === false) {
    configuredBrowserSessionManager = undefined
    return undefined
  }

  const manager = new BrowserSessionManager(session === true ? {} : session)
  configuredBrowserSessionManager = manager
  return manager
}

export function getBrowserSessionId(): string | undefined {
  return configuredBrowserSessionManager?.touch().id
}

export function clearConfiguredBrowserSession(manager: BrowserSessionManager): void {
  if (configuredBrowserSessionManager === manager) {
    manager.flushPendingStorage()
    configuredBrowserSessionManager = undefined
  }
}

export function clearConfiguredBrowserSessionForTests(): void {
  configuredBrowserSessionManager?.flushPendingStorage()
  configuredBrowserSessionManager = undefined
}
