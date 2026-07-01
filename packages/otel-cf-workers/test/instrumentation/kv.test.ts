import { describe, expect, it } from 'vitest'
import { KVAttributes } from '../../src/instrumentation/kv'

describe('KV attributes', () => {
  it('records the response cursor for incomplete list results', () => {
    expect(KVAttributes.list([{ cursor: 'request-cursor', limit: 10 }], { list_complete: false, cursor: 'response-cursor' })).toMatchObject(
      {
        'db.cf.kv.list_request_cursor': 'request-cursor',
        'db.cf.kv.list_limit': 10,
        'db.cf.kv.list_response_cursor': 'response-cursor',
      }
    )
  })
})
