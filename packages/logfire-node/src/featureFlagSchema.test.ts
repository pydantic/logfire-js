import { describe, expect, it } from 'vite-plus/test'

import { schemaForDiscovery } from './featureFlagSchema'

describe('feature flag discovery schema', () => {
  it('strips annotation values in definitions, alternatives and array items', () => {
    const schema = {
      $defs: {
        examples: {
          oneOf: [
            { type: 'string', examples: ['omit'] },
            { type: 'null', example: null },
          ],
        },
      },
      type: 'array',
      prefixItems: [{ $ref: '#/$defs/examples', default: 'omit' }],
      items: false,
    }
    expect(schemaForDiscovery(schema)).toBe(
      JSON.stringify({
        $defs: { examples: { oneOf: [{ type: 'string' }, { type: 'null' }] } },
        type: 'array',
        prefixItems: [{ $ref: '#/$defs/examples' }],
        items: false,
      })
    )
    expect(schema.prefixItems[0]?.default).toBe('omit')
  })

  it('measures the payload in bytes and skips an oversize schema', () => {
    const description = 'é'.repeat((16384 - '{"description":""}'.length) / 2)
    const payload = schemaForDiscovery({ description })
    expect(new TextEncoder().encode(payload).length).toBe(16384)
    expect(schemaForDiscovery({ description: description + 'a' })).toBeUndefined()
  })

  it('omits absent or unserializable schemas', () => {
    expect(schemaForDiscovery(undefined)).toBeUndefined()
    expect(schemaForDiscovery({ const: 1n })).toBeUndefined()
  })
})
