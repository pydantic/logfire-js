import type { Attributes } from '@opentelemetry/api'

export interface BrowserFrustrationOptions {
  /** Detect repeated clicks. Defaults to true when frustration reporting is enabled. */
  rageClicks?: boolean
  /** Experimental: distinguish a slow response from no response observed. Defaults to false. */
  deadClicks?: boolean
  /** CSS selectors matched against the target and its ancestors. */
  ignoreSelectors?: string[]
}

export function resolveBrowserFrustrationOptions(
  options: boolean | BrowserFrustrationOptions | undefined
): BrowserFrustrationOptions | undefined {
  if (options === undefined || options === false || (options !== true && options.rageClicks === false && options.deadClicks !== true)) {
    return undefined
  }
  return options === true ? {} : options
}

export interface FrustrationClick {
  target: number
  x: number
  y: number
  now: number
  timestamp: number
  attributes: Attributes
}

export interface FrustrationSignal {
  kind: 'rage_click' | 'slow_click' | 'dead_click'
  click: FrustrationClick
  count: number
  delay: number
  response?: string
}

interface Candidate {
  click: FrustrationClick
  count: number
}

/** Pure, bounded detector. All intervals use a monotonic clock supplied by the adapter. */
export class InteractionFrustrationDetector {
  private readonly options: BrowserFrustrationOptions
  private readonly emit: (signal: FrustrationSignal) => void
  private episode: Candidate | undefined
  private lastClickAt = 0
  private generation = 0
  private readonly pending = new Map<number, Candidate>()

  constructor(options: BrowserFrustrationOptions, emit: (signal: FrustrationSignal) => void) {
    this.options = options
    this.emit = emit
  }

  click(click: FrustrationClick): void {
    const generation = this.generation
    this.advance(click.now)
    if (this.generation !== generation) {
      return
    }
    const episode = this.episode
    if (
      episode !== undefined &&
      episode.click.target === click.target &&
      click.now - this.lastClickAt < 1000 &&
      Math.hypot(click.x - episode.click.x, click.y - episode.click.y) < 30
    ) {
      episode.count++
      if (episode.count === 3 && this.options.rageClicks !== false) {
        this.emit({ kind: 'rage_click', click: episode.click, count: episode.count, delay: click.now - episode.click.now })
      }
    } else {
      this.episode = { click, count: 1 }
    }
    // Reporting calls customer span processors synchronously. A navigation or shutdown in
    // one of those callbacks must take precedence over this in-flight click.
    if (this.generation !== generation) {
      return
    }
    this.lastClickAt = click.now
    if (this.options.deadClicks === true) {
      const pending = this.pending.get(click.target)
      if (pending !== undefined) {
        pending.count++
      } else if (this.pending.size < 32) {
        this.pending.set(click.target, { click, count: 1 })
      }
    }
  }

  /** Earliest pending expiry, used to schedule one timeout rather than poll while idle. */
  get nextDeadline(): number | undefined {
    let deadline: number | undefined
    for (const { click } of this.pending.values()) {
      const expiresAt = click.now + 7000
      deadline = deadline === undefined ? expiresAt : Math.min(deadline, expiresAt)
    }
    return deadline
  }

  /** Broad liveness heuristic, not causal evidence that an interaction succeeded. */
  response(now: number, response = 'dom_change'): void {
    for (const candidate of this.pending.values()) {
      const delay = now - candidate.click.now
      if (delay >= 2500) {
        this.emit({ kind: delay < 7000 ? 'slow_click' : 'dead_click', ...candidate, delay, response })
      }
    }
    this.pending.clear()
  }

  advance(now: number): void {
    for (const [target, candidate] of this.pending) {
      if (now - candidate.click.now >= 7000) {
        this.pending.delete(target)
        this.emit({ kind: 'dead_click', ...candidate, delay: now - candidate.click.now })
      }
    }
  }

  /** Discard ambiguous response observations without changing repeated-click detection. */
  cancelPending(): void {
    this.generation++
    this.pending.clear()
  }

  reset(): void {
    this.cancelPending()
    this.episode = undefined
    this.lastClickAt = 0
  }
}
