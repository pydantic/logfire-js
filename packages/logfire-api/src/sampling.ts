import type { Context } from '@opentelemetry/api'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

import { ATTRIBUTES_LEVEL_KEY } from './constants'

type LevelName = 'debug' | 'error' | 'fatal' | 'info' | 'notice' | 'trace' | 'warning'

const LEVEL_NUMBERS: Record<LevelName, number> = {
  debug: 5,
  error: 17,
  fatal: 21,
  info: 9,
  notice: 10,
  trace: 1,
  warning: 13,
}

const DEFAULT_LEVEL_NUM = LEVEL_NUMBERS.info

const NUMBER_TO_NAME = new Map<number, LevelName>(Object.entries(LEVEL_NUMBERS).map(([name, num]) => [num, name as LevelName]))

export class SpanLevel {
  readonly number: number
  get name(): LevelName | undefined {
    return NUMBER_TO_NAME.get(this.number)
  }

  constructor(number: number) {
    this.number = number
  }

  static fromSpan(span: ReadableSpan): SpanLevel {
    const levelNum = span.attributes[ATTRIBUTES_LEVEL_KEY]
    return new SpanLevel(typeof levelNum === 'number' ? levelNum : DEFAULT_LEVEL_NUM)
  }

  gt(level: LevelName): boolean {
    return this.number > LEVEL_NUMBERS[level]
  }

  gte(level: LevelName): boolean {
    return this.number >= LEVEL_NUMBERS[level]
  }

  lt(level: LevelName): boolean {
    return this.number < LEVEL_NUMBERS[level]
  }

  lte(level: LevelName): boolean {
    return this.number <= LEVEL_NUMBERS[level]
  }
}

export interface TailSamplingSpanInfo {
  context: Context | null
  duration: number
  event: 'end' | 'start'
  level: SpanLevel
  span: ReadableSpan
}

export interface SamplingOptions {
  /** Head sampling rate (0.0-1.0). Default: 1.0 (sample everything). */
  head?: number
  /** Tail sampling callback. Return 0.0-1.0 probability for the entire trace. */
  tail?: (spanInfo: TailSamplingSpanInfo) => number
}

/**
 * Deterministic sampling decision based on trace ID, matching OTel JS's
 * TraceIdRatioBasedSampler algorithm. XOR-accumulates 8-char hex chunks
 * of the trace ID and compares against the threshold.
 */
export function checkTraceIdRatio(traceId: string, rate: number): boolean {
  if (rate >= 1.0) {
    return true
  }
  if (rate <= 0.0) {
    return false
  }

  let accumulation = 0
  for (let i = 0; i < traceId.length / 8; i++) {
    const pos = i * 8
    const piece = parseInt(traceId.substring(pos, pos + 8), 16)
    accumulation = (accumulation ^ piece) >>> 0
  }

  const threshold = Math.floor(rate * 0xffffffff)
  return accumulation <= threshold
}

/**
 * Convenience factory for the common sampling pattern: keep traces that contain
 * spans with high severity levels or that exceed a duration threshold.
 */
export function levelOrDuration(options?: {
  backgroundRate?: number
  durationThreshold?: number
  head?: number
  levelThreshold?: LevelName
}): SamplingOptions {
  const levelThreshold = options?.levelThreshold ?? 'notice'
  const durationThreshold = options?.durationThreshold ?? 5.0
  const backgroundRate = options?.backgroundRate ?? 0.0

  return {
    head: options?.head,
    tail: (spanInfo: TailSamplingSpanInfo): number => {
      if (spanInfo.level.gte(levelThreshold)) {
        return 1.0
      }
      if (spanInfo.duration >= durationThreshold) {
        return 1.0
      }
      return backgroundRate
    },
  }
}
