import { startSessionReplay } from 'lf-replay-delivery'

declare global {
  interface Window {
    logfireReplayIdentity: {
      inheritedSequence: string | null
      documentId: string
      pageShows: boolean[]
      restoreStates: { owner: string | null; identity: string | null; sequence: string | null }[]
      recordingId: string
      rumSessionId: string
      flush(): Promise<void>
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
const restoreStates: { owner: string | null; identity: string | null; sequence: string | null }[] = []
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    restoreStates.push({
      owner: sessionStorage.getItem('lf_session_replay_recording_owner'),
      identity: sessionStorage.getItem('lf_session_replay_recording'),
      sequence: sessionStorage.getItem('lf_session_replay_seq'),
    })
  }
})
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
const pageShows: boolean[] = []
window.addEventListener('pageshow', (event) => {
  pageShows.push(event.persisted)
})
window.logfireReplayIdentity = {
  inheritedSequence,
  documentId: crypto.randomUUID(),
  pageShows,
  restoreStates,
  get recordingId() {
    return replay.getRecordingId()
  },
  get rumSessionId() {
    return replay.getSessionId()
  },
  flush: async () => replay.flush(),
  stop: async () => replay.stop(),
}
document.querySelector('#open-tab')?.addEventListener('click', () => {
  window.open('/identity.html', '_blank')
})
await replay.flush()
status.textContent = 'ready'
