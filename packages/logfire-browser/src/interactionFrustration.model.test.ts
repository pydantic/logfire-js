import { env } from 'node:process'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'
import { InteractionFrustrationDetector } from './interactionFrustration'
import type { FrustrationClick, FrustrationSignal } from './interactionFrustration'

const parameters = {
  seed: Number(env['FRUSTRATION_SEED'] ?? 20261022),
  numRuns: Number(env['FRUSTRATION_RUNS'] ?? 500),
  path: env['FRUSTRATION_PATH'] ?? '',
}
const step = fc.record({
  action: fc.constantFrom('click', 'advance', 'response', 'reset', 'cancel', 'fill'),
  delta: fc.oneof(fc.constantFrom(0, 999, 1000, 2499, 2500, 6999, 7000, 9001), fc.integer({ min: 0, max: 10000 })),
  target: fc.integer({ min: 0, max: 40 }),
  x: fc.integer({ min: -40, max: 40 }),
  y: fc.integer({ min: -40, max: 40 }),
})
type Step = typeof step extends fc.Arbitrary<infer T> ? T : never

function clickAt(now: number, target: number, x = 0, y = 0): FrustrationClick {
  return { now, timestamp: 100000 + now, target, x, y, attributes: { 'session.id': 'frozen', 'logfire.page.route': '/original' } }
}

function apply(detector: InteractionFrustrationDetector, command: Step, now: number): void {
  switch (command.action) {
    case 'click':
      detector.click(clickAt(now, command.target, command.x, command.y))
      break
    case 'fill':
      for (let target = 0; target < 40; target++) {
        detector.click(clickAt(now, target))
      }
      break
    case 'advance':
      detector.advance(now)
      break
    case 'response':
      detector.response(now, 'scroll')
      break
    case 'reset':
      detector.reset()
      break
    case 'cancel':
      detector.cancelPending()
      break
    default:
      throw new Error('unknown generated action')
  }
}

describe('generated frustration histories', () => {
  it('matches an independent deadline-ticket model after every action', () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 20, maxLength: 200 }), (commands) => {
        const actual: FrustrationSignal[] = []
        const expected: FrustrationSignal[] = []
        const detector = new InteractionFrustrationDetector({ rageClicks: false, deadClicks: true }, (signal) => {
          actual.push(signal)
        })
        // A ticket is the first click on a target; repeats neither extend nor replace it.
        // No rage/observer/timer implementation is reproduced in this model.
        let tickets: { click: FrustrationClick; count: number }[] = []
        let now = 0
        const settle = (response: boolean) => {
          const due = tickets.filter(({ click }) => response || now >= click.now + 7000)
          tickets = tickets.filter((ticket) => !due.includes(ticket))
          for (const ticket of due) {
            const delay = now - ticket.click.now
            if (delay >= 2500) {
              expected.push({
                ...ticket,
                kind: delay >= 7000 ? 'dead_click' : 'slow_click',
                delay,
                ...(response ? { response: 'scroll' } : {}),
              })
            }
          }
        }
        for (const command of commands) {
          now += command.delta
          if (command.action === 'reset' || command.action === 'cancel') {
            tickets = []
          } else if (command.action === 'response' || command.action === 'advance') {
            settle(command.action === 'response')
          } else {
            settle(false)
            const clickedAt = now
            const clicks =
              command.action === 'fill'
                ? Array.from({ length: 40 }, (_, target) => clickAt(clickedAt, target))
                : [clickAt(now, command.target, command.x, command.y)]
            for (const click of clicks) {
              const ticket = tickets.find((entry) => entry.click.target === click.target)
              if (ticket !== undefined) {
                ticket.count++
              } else if (tickets.length < 32) {
                tickets.push({ click, count: 1 })
              }
            }
          }
          apply(detector, command, now)
          expect(actual).toEqual(expected)
          expect(detector.nextDeadline).toBe(tickets.length === 0 ? undefined : Math.min(...tickets.map(({ click }) => click.now + 7000)))
        }
      }),
      parameters
    )
  })

  it('makes any pre-reset history observationally irrelevant to subsequent clicks', () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 10, maxLength: 80 }), fc.array(step, { minLength: 10, maxLength: 80 }), (prefix, suffix) => {
        const actual: FrustrationSignal[] = []
        const fresh: FrustrationSignal[] = []
        const detector = new InteractionFrustrationDetector({ deadClicks: true }, (signal) => {
          actual.push(signal)
        })
        const reference = new InteractionFrustrationDetector({ deadClicks: true }, (signal) => {
          fresh.push(signal)
        })
        let now = 0
        for (const command of prefix) {
          now += command.delta
          apply(detector, command, now)
        }
        detector.reset()
        actual.length = 0
        for (const command of suffix) {
          now += command.delta
          apply(detector, command, now)
          apply(reference, command, now)
          expect(actual).toEqual(fresh)
          expect(detector.nextDeadline).toBe(reference.nextDeadline)
        }
      }),
      parameters
    )
  })

  it('reports exactly once for arbitrary qualifying rage bursts and freezes the first click', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 999 }), { minLength: 3, maxLength: 50 }), fc.integer(), (gaps, target) => {
        const signals: FrustrationSignal[] = []
        const detector = new InteractionFrustrationDetector({}, (signal) => {
          signals.push(signal)
        })
        let now = 0
        for (const gap of gaps) {
          now += gap
          detector.click(clickAt(now, target, 18, 24))
        }
        expect(signals).toEqual([
          { kind: 'rage_click', click: clickAt(gaps[0] ?? 0, target, 18, 24), count: 3, delay: (gaps[1] ?? 0) + (gaps[2] ?? 0) },
        ])
        expect(detector.nextDeadline).toBeUndefined()
      }),
      parameters
    )
  })

  it('never resurrects work when emission synchronously resets a generated population', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 40 }),
        fc.boolean(),
        (targets, useResponse) => {
          const signals: FrustrationSignal[] = []
          const detector = new InteractionFrustrationDetector({ deadClicks: true }, (signal) => {
            signals.push(signal)
            detector.reset()
          })
          for (const target of targets) {
            detector.click(clickAt(0, target))
          }
          if (useResponse) {
            detector.response(7000)
          } else {
            detector.click(clickAt(7000, 200))
          }
          expect(signals).toHaveLength(1)
          expect(detector.nextDeadline).toBeUndefined()
          detector.advance(20000)
          expect(signals).toHaveLength(1)
          // Also check rage state, not merely pending deadlines. A stale in-flight
          // click must not become the first click of the next episode after reset.
          detector.click(clickAt(20100, 200))
          detector.click(clickAt(20200, 200))
          expect(signals).toHaveLength(1)
          detector.click(clickAt(20300, 200))
          expect(signals).toHaveLength(2)
          expect(signals[1]?.click).toEqual(clickAt(20100, 200))
        }
      ),
      parameters
    )
  })
})
