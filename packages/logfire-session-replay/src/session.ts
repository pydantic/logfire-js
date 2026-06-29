import { uuidv7 } from './uuid'

export const SESSION_STORAGE_KEY = 'lf_session_replay'

export interface SessionState {
  id: string
  startedAt: number
  lastActivityAt: number
}

export interface SessionManagerOptions {
  idleTimeoutMs: number
  maxDurationMs: number
  now?: () => number
  storage?: Storage | null
}

export class SessionManager {
  private readonly idleTimeoutMs: number
  private readonly maxDurationMs: number
  private readonly now: () => number
  private readonly storage: Storage | null
  private memorySession: SessionState | undefined

  constructor(options: SessionManagerOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs
    this.maxDurationMs = options.maxDurationMs
    this.now = options.now ?? Date.now
    this.storage = options.storage === undefined ? safeSessionStorage() : options.storage
  }

  getSession(): SessionState {
    const now = this.now()
    const session = this.read()
    if (session !== undefined && !this.isExpired(session, now)) {
      return session
    }
    return this.createSession(now)
  }

  touch(): SessionState {
    const now = this.now()
    const session = this.getSession()
    const touchedSession = { ...session, lastActivityAt: now }
    this.write(touchedSession)
    return touchedSession
  }

  reset(): SessionState {
    return this.createSession(this.now())
  }

  private isExpired(session: SessionState, now: number): boolean {
    return now - session.lastActivityAt > this.idleTimeoutMs || now - session.startedAt > this.maxDurationMs
  }

  private createSession(now: number): SessionState {
    const session = {
      id: uuidv7(this.now),
      startedAt: now,
      lastActivityAt: now,
    }
    this.write(session)
    return session
  }

  private read(): SessionState | undefined {
    if (this.storage !== null) {
      try {
        const raw = this.storage.getItem(SESSION_STORAGE_KEY)
        if (raw !== null) {
          const parsed: unknown = JSON.parse(raw)
          if (isSessionState(parsed)) {
            this.memorySession = parsed
            return parsed
          }
        }
      } catch {
        return this.memorySession
      }
    }

    return this.memorySession
  }

  private write(session: SessionState): void {
    this.memorySession = session
    if (this.storage === null) {
      return
    }

    try {
      this.storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
    } catch {
      // Session identity is best-effort in constrained browser contexts.
    }
  }
}

export function safeSessionStorage(): Storage | null {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null
  } catch {
    return null
  }
}

function isSessionState(value: unknown): value is SessionState {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const maybeSession = value as Partial<SessionState>
  return (
    typeof maybeSession.id === 'string' &&
    maybeSession.id.length > 0 &&
    typeof maybeSession.startedAt === 'number' &&
    Number.isFinite(maybeSession.startedAt) &&
    typeof maybeSession.lastActivityAt === 'number' &&
    Number.isFinite(maybeSession.lastActivityAt)
  )
}
