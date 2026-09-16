import type { SessionReplayConfig } from './types'
import type { startSessionReplay } from './index'

export type SessionReplayIntegrationOptions = Omit<
  SessionReplayConfig,
  | 'getSessionAttributes'
  | 'getSessionId'
  | 'headers'
  | 'maxSessionDurationMs'
  | 'now'
  | 'random'
  | 'replayUrl'
  | 'sessionIdleTimeoutMs'
  | 'token'
>

export interface SessionReplayIntegration extends SessionReplayIntegrationOptions {
  load: () => Promise<{ startSessionReplay: typeof startSessionReplay }>
}

/**
 * Configure the optional browser SDK integration without eagerly bundling the
 * session replay recorder.
 */
export function sessionReplayIntegration(options: SessionReplayIntegrationOptions = {}): SessionReplayIntegration {
  return {
    ...options,
    load: async () => import('./index'),
  }
}
