import { describe, expect, it, vi } from 'vitest'

import { snapshotSessionAttributes } from './sessionAttributes'

const ignoreError = vi.fn<(error: unknown) => void>()

describe('snapshotSessionAttributes', () => {
  it('accepts bounded primitive dimensions and freezes the snapshot', () => {
    const source = {
      account_tier: 'pro',
      beta_user: true,
      seats: 12,
      skipped: undefined,
    }

    const attributes = snapshotSessionAttributes(() => source, ignoreError)
    source.account_tier = 'free'

    expect(attributes).toEqual({
      account_tier: 'pro',
      beta_user: true,
      seats: 12,
    })
    expect(Object.isFrozen(attributes)).toBe(true)
  })

  it('enforces key, value, count, and Unicode code-point limits', () => {
    const reporter = vi.fn<(error: unknown) => void>()
    const entries: Record<string, unknown> = {
      Invalid: 'uppercase',
      invalid_dash: undefined,
      invalid_object: {},
      invalid_infinity: Number.POSITIVE_INFINITY,
      invalid_nan: Number.NaN,
      invalid_string: '🚀'.repeat(201),
      valid_unicode: '🚀'.repeat(200),
    }
    for (let index = 0; index < 25; index++) {
      entries[`valid_${index.toString()}`] = index
    }
    entries['invalid-key'] = 'dash'
    entries[`a${'b'.repeat(64)}`] = 'too long'

    const attributes = snapshotSessionAttributes(() => entries as Record<string, string | number | boolean | undefined>, reporter)

    expect(attributes['valid_unicode']).toBe('🚀'.repeat(200))
    expect(Object.keys(attributes)).toHaveLength(20)
    expect(attributes['valid_18']).toBe(18)
    expect(attributes['valid_19']).toBeUndefined()
    expect(attributes['Invalid']).toBeUndefined()
    expect(attributes['invalid-key']).toBeUndefined()
    expect(reporter).not.toHaveBeenCalled()
  })

  it('accepts null-prototype, frozen, and sealed objects and rejects other container classes', () => {
    const nullPrototype = Object.assign(Object.create(null) as Record<string, string>, { tier: 'pro' })
    const frozen = Object.freeze({ tier: 'frozen' })
    const sealed = Object.seal({ tier: 'sealed' })
    class Dimensions {
      tier = 'pro'
    }

    expect(snapshotSessionAttributes(() => nullPrototype, ignoreError)).toEqual({ tier: 'pro' })
    expect(snapshotSessionAttributes(() => frozen, ignoreError)).toEqual({ tier: 'frozen' })
    expect(snapshotSessionAttributes(() => sealed, ignoreError)).toEqual({ tier: 'sealed' })
    expect(snapshotSessionAttributes(() => [] as never, ignoreError)).toEqual({})
    expect(snapshotSessionAttributes(() => (() => ({})) as never, ignoreError)).toEqual({})
    expect(snapshotSessionAttributes(() => new Date() as never, ignoreError)).toEqual({})
    expect(snapshotSessionAttributes(() => new Dimensions() as never, ignoreError)).toEqual({})
  })

  it('reports exceptional callback, prototype, enumeration, and property access once each', () => {
    const callbackError = new Error('callback')
    const callbackReporter = vi.fn<(error: unknown) => void>()
    expect(
      snapshotSessionAttributes(() => {
        throw callbackError
      }, callbackReporter)
    ).toEqual({})
    expect(callbackReporter).toHaveBeenCalledExactlyOnceWith(callbackError)

    const prototypeError = new Error('prototype')
    const prototypeReporter = vi.fn<(error: unknown) => void>()
    const prototypeProxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw prototypeError
        },
      }
    )
    expect(snapshotSessionAttributes(() => prototypeProxy, prototypeReporter)).toEqual({})
    expect(prototypeReporter).toHaveBeenCalledExactlyOnceWith(prototypeError)

    const enumerationError = new Error('enumeration')
    const enumerationReporter = vi.fn<(error: unknown) => void>()
    const enumerationProxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw enumerationError
        },
      }
    )
    expect(snapshotSessionAttributes(() => enumerationProxy, enumerationReporter)).toEqual({})
    expect(enumerationReporter).toHaveBeenCalledExactlyOnceWith(enumerationError)

    const propertyError = new Error('property')
    const propertyReporter = vi.fn<(error: unknown) => void>()
    const propertyProxy = new Proxy(
      { broken: 'ignored', healthy: true },
      {
        get: (target, key, receiver) => {
          if (key === 'broken') {
            throw propertyError
          }
          return Reflect.get(target, key, receiver) as unknown
        },
      }
    )
    expect(snapshotSessionAttributes(() => propertyProxy, propertyReporter)).toEqual({ healthy: true })
    expect(propertyReporter).toHaveBeenCalledExactlyOnceWith(propertyError)
  })
})
