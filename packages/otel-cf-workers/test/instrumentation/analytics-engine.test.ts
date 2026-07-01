import { describe, expect, it } from 'vitest'
import { AEAttributes } from '../../src/instrumentation/analytics-engine'

describe('Analytics Engine attributes', () => {
  it('handles partial data points without optional arrays', () => {
    expect(AEAttributes.writeDataPoint([{}], undefined)).toEqual({
      'db.cf.ae.indexes': 0,
      'db.cf.ae.doubles': 0,
      'db.cf.ae.blobs': 0,
    })
  })

  it('records provided data point array counts', () => {
    expect(AEAttributes.writeDataPoint([{ indexes: ['index'], doubles: [1, 2], blobs: ['blob'] }], undefined)).toEqual({
      'db.cf.ae.indexes': 1,
      'db.cf.ae.index': 'index',
      'db.cf.ae.doubles': 2,
      'db.cf.ae.blobs': 1,
    })
  })
})
