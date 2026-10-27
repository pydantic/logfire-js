import { describe, expect, it } from 'vite-plus/test'
import { InteractionFrustrationDetector, resolveBrowserFrustrationOptions } from './interactionFrustration'
import type { BrowserFrustrationOptions, FrustrationSignal } from './interactionFrustration'

function setup() {
  const signals: FrustrationSignal[] = []
  const detector = new InteractionFrustrationDetector({ deadClicks: true }, (signal) => {
    signals.push(signal)
  })
  const click = (now: number, x = 0, target = 1) => {
    detector.click({ now, x, y: 0, target, timestamp: 10000 + now, attributes: { 'session.id': 'original' } })
  }
  return { signals, detector, click }
}

describe('interaction frustration', () => {
  it('cancels pending responses without erasing the anchored rage episode', () => {
    const { signals, detector, click } = setup()
    click(0)
    click(100)
    detector.cancelPending()
    expect(detector.nextDeadline).toBeUndefined()
    click(200)
    expect(signals.map(({ kind, count, delay }) => ({ kind, count, delay }))).toEqual([{ kind: 'rage_click', count: 3, delay: 200 }])
    expect(detector.nextDeadline).toBe(7200)
    detector.cancelPending()
    detector.advance(10000)
    expect(signals).toHaveLength(1)
  })

  it.each(['rage', 'expiry'] as const)('does not resurrect pending work canceled during %s emission', (phase) => {
    const signals: FrustrationSignal[] = []
    const detector = new InteractionFrustrationDetector({ deadClicks: true }, (signal) => {
      signals.push(signal)
      detector.cancelPending()
    })
    for (const now of phase === 'rage' ? [0, 100, 200] : [0, 7000]) {
      detector.click({ now, timestamp: now, x: 0, y: 0, target: 1, attributes: {} })
    }
    expect(detector.nextDeadline).toBeUndefined()
    detector.advance(15000)
    expect(signals.map(({ kind }) => kind)).toEqual([phase === 'rage' ? 'rage_click' : 'dead_click'])
  })

  it('does not advance the rage episode when an expiry callback cancels the in-flight click', () => {
    const signals: FrustrationSignal[] = []
    const detector = new InteractionFrustrationDetector({ deadClicks: true }, (signal) => {
      signals.push(signal)
      if (signal.kind === 'dead_click') {
        detector.cancelPending()
      }
    })
    const click = (now: number) => {
      detector.click({ now, timestamp: now, x: 0, y: 0, target: 1, attributes: {} })
    }
    click(0)
    click(6500)
    click(7000) // Expiry cancels this click before it can join the newer episode.
    click(7100)
    expect(signals.map(({ kind }) => kind)).toEqual(['dead_click'])
    click(7200)
    expect(signals.map(({ kind, delay }) => ({ kind, delay }))).toEqual([
      { kind: 'dead_click', delay: 7000 },
      { kind: 'rage_click', delay: 700 },
    ])
  })

  it.each([
    [undefined, undefined],
    [false, undefined],
    [true, {}],
    [{}, {}],
    [{ rageClicks: false }, undefined],
    [{ rageClicks: false, deadClicks: false }, undefined],
    [
      { rageClicks: false, deadClicks: true },
      { rageClicks: false, deadClicks: true },
    ],
    [
      { rageClicks: true, deadClicks: false },
      { rageClicks: true, deadClicks: false },
    ],
    [
      { deadClicks: true, ignoreSelectors: ['.private'] },
      { deadClicks: true, ignoreSelectors: ['.private'] },
    ],
  ] satisfies [boolean | BrowserFrustrationOptions | undefined, BrowserFrustrationOptions | undefined][])(
    'normalizes opt-in configuration %j',
    (options, expected) => {
      expect(resolveBrowserFrustrationOptions(options)).toEqual(expected)
    }
  )
  for (const phase of ['rage', 'expiry'] as const) {
    it(`honors a re-entrant reset while emitting a ${phase} signal`, () => {
      const signals: FrustrationSignal[] = []
      const detector = new InteractionFrustrationDetector({ deadClicks: true }, (signal) => {
        signals.push(signal)
        detector.reset()
      })
      for (const now of phase === 'rage' ? [0, 100, 200] : [0, 7000]) {
        detector.click({ now, timestamp: now, x: 0, y: 0, target: 1, attributes: {} })
      }
      expect(detector.nextDeadline).toBeUndefined()
      detector.advance(15000)
      expect(signals.map(({ kind }) => kind)).toEqual([phase === 'rage' ? 'rage_click' : 'dead_click'])
    })
  }

  it('emits once per anchored rage episode, including successive rather than total time', () => {
    const { signals, click } = setup()
    for (const time of [0, 900, 1800, 1900]) {
      click(time)
    }
    expect(signals.map(({ kind, count, delay }) => ({ kind, count, delay }))).toEqual([{ kind: 'rage_click', count: 3, delay: 1800 }])
    expect(signals[0]?.click.timestamp).toBe(10000)
  })
  it('rejects spatial drift, different targets and the exact gap boundary', () => {
    for (const clicks of [
      [
        [0, 0, 1],
        [100, 20, 1],
        [200, 40, 1],
      ],
      [
        [0, 0, 1],
        [100, 0, 2],
        [200, 0, 1],
      ],
      [
        [0, 0, 1],
        [1000, 0, 1],
        [1100, 0, 1],
      ],
    ] as const) {
      const { signals, click } = setup()
      for (const [time, x, target] of clicks) {
        click(time, x, target)
      }
      expect(signals).toEqual([])
    }
  })
  it('suppresses fast responses and classifies slow responses without losing click context', () => {
    const { signals, click, detector } = setup()
    click(0)
    detector.response(2499)
    detector.advance(9000)
    expect(signals).toEqual([])
    click(10000)
    detector.response(12500)
    expect(signals.map(({ kind, delay }) => ({ kind, delay }))).toEqual([{ kind: 'slow_click', delay: 2500 }])
    expect(signals[0]?.click.attributes).toEqual({ 'session.id': 'original' })
  })
  it('emits one dead signal after seven seconds, with repeated clicks deduplicated', () => {
    const { signals, click, detector } = setup()
    click(0)
    click(1500)
    detector.advance(6999)
    expect(signals).toEqual([])
    detector.advance(7000)
    detector.advance(8000)
    expect(signals.map(({ kind, count, delay }) => ({ kind, count, delay }))).toEqual([{ kind: 'dead_click', count: 2, delay: 7000 }])
  })
  it('bounds pending candidates and discards incomplete observations on reset', () => {
    const { signals, click, detector } = setup()
    for (let target = 0; target < 100; target++) {
      click(0, 0, target)
    }
    detector.advance(7000)
    expect(signals.length).toBe(32)
    signals.length = 0
    click(8000)
    detector.reset()
    detector.advance(15000)
    expect(signals).toEqual([])
  })
  it('keeps dead-click detection off by default and supports disabling rage detection', () => {
    const signals: FrustrationSignal[] = []
    const detector = new InteractionFrustrationDetector({ rageClicks: false }, (signal) => {
      signals.push(signal)
    })
    for (const now of [0, 100, 200]) {
      detector.click({ now, timestamp: now, target: 1, x: 0, y: 0, attributes: {} })
    }
    detector.advance(9000)
    expect(signals).toEqual([])
  })

  it('exposes only the earliest live deadline and never extends it on repeated clicks', () => {
    const { click, detector } = setup()
    expect(detector.nextDeadline).toBeUndefined()
    click(0)
    click(1000)
    click(2000, 0, 2)
    expect(detector.nextDeadline).toBe(7000)
    detector.advance(7000)
    expect(detector.nextDeadline).toBe(9000)
    detector.response(7100)
    expect(detector.nextDeadline).toBeUndefined()
  })

  it('expires an old candidate before admitting another click on the same target', () => {
    const { signals, click, detector } = setup()
    click(0)
    click(7000)
    expect(signals.map(({ kind, count }) => ({ kind, count }))).toEqual([{ kind: 'dead_click', count: 1 }])
    expect(detector.nextDeadline).toBe(14000)
  })

  it('treats exactly 30 pixels as outside the rage episode', () => {
    const { signals, click } = setup()
    click(0)
    click(100, 15)
    click(200, 30)
    expect(signals).toEqual([])
  })

  it.each([
    { x: 20, y: 20, count: 1 }, // sqrt(800) < 30, although Manhattan distance is 40.
    { x: 22, y: 22, count: 0 }, // sqrt(968) > 30, although both coordinates are below 30.
    { x: 18, y: 24, count: 0 }, // sqrt(900) is exactly the excluded boundary.
  ])('uses Euclidean distance for diagonal motion ($x, $y)', ({ x, y, count }) => {
    const { detector, signals } = setup()
    for (const [now, dx, dy] of [
      [0, 0, 0],
      [100, x, y],
      [200, x, y],
    ] as const) {
      detector.click({ now, x: dx, y: dy, target: 1, timestamp: now, attributes: {} })
    }
    expect(signals.filter(({ kind }) => kind === 'rage_click')).toHaveLength(count)
  })
})
