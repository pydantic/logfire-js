import { describe, expect, it } from 'vitest'

import { uuidv7 } from './uuid'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

describe('uuidv7', () => {
  it('produces a well-formed v7 uuid', () => {
    expect(uuidv7()).toMatch(UUID_RE)
  })

  it('is time ordered', () => {
    expect(uuidv7(() => 1_000_000_000_000) < uuidv7(() => 2_000_000_000_000)).toBe(true)
  })

  it('is unique across calls at the same instant', () => {
    const now = () => 1_700_000_000_000
    const ids = new Set(Array.from({ length: 200 }, () => uuidv7(now)))
    expect(ids.size).toBe(200)
  })
})
