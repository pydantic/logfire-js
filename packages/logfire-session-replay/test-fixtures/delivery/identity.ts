import { startSessionReplay } from 'lf-replay-delivery'

declare global {
  interface Window {
    logfireReplayIdentity: {
      inheritedSequence: string | null
      recordingId: string
      rumSessionId: string
      stop(): Promise<void>
    }
  }
}

const payload = document.querySelector('#payload')
const status = document.querySelector('[role="status"]')
if (payload === null || status === null) {
  throw new Error('identity fixture markup is missing')
}
payload.textContent = window.opener === null ? 'parent-marker' : 'child-marker'
const inheritedSequence = sessionStorage.getItem('lf_session_replay_seq')
const rumSessionId = sessionStorage.getItem('identity-rum-session') ?? 'shared-rum-session'
sessionStorage.setItem('identity-rum-session', rumSessionId)
const replay = startSessionReplay({
  captureConsole: false,
  captureNavigation: false,
  captureNetwork: false,
  flushIntervalMs: 60_000,
  getSessionId: () => rumSessionId,
  maskAllText: false,
  minSessionDurationMs: 0,
  replayUrl: '/replay/identity',
  sessionSampleRate: 1,
})
window.logfireReplayIdentity = {
  inheritedSequence,
  recordingId: replay.getRecordingId(),
  rumSessionId: replay.getSessionId(),
  stop: async () => replay.stop(),
}
document.querySelector('#open-tab')?.addEventListener('click', () => {
  window.open('/identity.html', '_blank')
})
await replay.flush()
status.textContent = 'ready'
