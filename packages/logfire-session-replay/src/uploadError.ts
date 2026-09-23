/**
 * - `unconfirmed`: retries ended after a request reached the network; the server may hold the chunk.
 * - `rejected`: the server answered with a terminal HTTP status.
 * - `not-sent`: no request reached the network (queue full, compression, headers or token failed).
 */
export type ReplayUploadFailureReason = 'unconfirmed' | 'rejected' | 'not-sent'

export interface ReplayUploadErrorInit {
  cause: unknown
  droppedSeqs?: readonly number[]
  reason: ReplayUploadFailureReason
  seq: number | undefined
  sessionId: string
  status?: number | undefined
}

/**
 * Reported through `onError` when a replay chunk is not confirmed by the server.
 * Recording continues from a fresh full snapshot, so `droppedSeqs` lists the
 * later chunks that were discarded because they depended on the lost one.
 */
export class ReplayUploadError extends Error {
  readonly droppedSeqs: readonly number[]
  readonly reason: ReplayUploadFailureReason
  readonly seq: number | undefined
  readonly sessionId: string
  readonly status: number | undefined

  constructor(init: ReplayUploadErrorInit) {
    super(describe(init), { cause: init.cause })
    this.name = 'ReplayUploadError'
    this.droppedSeqs = Object.freeze([...(init.droppedSeqs ?? [])])
    this.reason = init.reason
    this.seq = init.seq
    this.sessionId = init.sessionId
    this.status = init.status
  }
}

function describe(init: ReplayUploadErrorInit): string {
  const chunk = init.seq === undefined ? 'replay chunk' : `replay chunk seq=${String(init.seq)}`
  const detail = init.cause instanceof Error ? `: ${init.cause.message}` : ''
  return `${chunk} ${init.reason}${detail}`
}
