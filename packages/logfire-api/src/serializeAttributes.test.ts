import { beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { JSON_NULL_FIELDS_KEY, JSON_SCHEMA_KEY } from './constants'
import { configureLogfireApi } from './logfireApiConfig'
import { serializeAttributes } from './serializeAttributes'

function parseSchema(result: Record<string, unknown>): unknown {
  const schema = result[JSON_SCHEMA_KEY]
  expect(typeof schema).toBe('string')
  return JSON.parse(schema as string) as unknown
}

describe('serializeAttributes', () => {
  beforeEach(() => {
    configureLogfireApi({
      jsonSchema: 'rich',
      minLevel: null,
      scrubbing: {},
    })
  })

  test('keeps top-level primitives and nullish metadata behavior unchanged', () => {
    expect(serializeAttributes({ active: true, count: 2, missing: undefined, name: 'Ada', nothing: null })).toEqual({
      active: true,
      count: 2,
      [JSON_NULL_FIELDS_KEY]: ['missing', 'nothing'],
      name: 'Ada',
    })
  })

  test('sends a non-finite number as a string rather than losing it to JSON null', () => {
    const result = serializeAttributes({
      inf: Number.POSITIVE_INFINITY,
      nan: Number.NaN,
      neginf: Number.NEGATIVE_INFINITY,
      ok: 1.5,
      zero: -0,
    })

    expect(result).toEqual({
      inf: 'Infinity',
      nan: 'NaN',
      neginf: '-Infinity',
      ok: 1.5,
      zero: -0,
    })
    // The point of the change: these used to reach the wire as null.
    expect(JSON.stringify(result)).toBe('{"inf":"Infinity","nan":"NaN","neginf":"-Infinity","ok":1.5,"zero":0}')
  })

  test('sends a nested non-finite number as a string, like the top-level one', () => {
    const result = serializeAttributes({
      nested: { inf: Number.POSITIVE_INFINITY, list: [Number.NaN, 2], nan: Number.NaN, ok: 1.5 },
    })

    // These used to reach the wire as `null`, indistinguishable from an actual null. The list
    // schema drops `items` because the array became heterogeneous, a string beside a number.
    expect(result['nested']).toBe('{"inf":"Infinity","list":["NaN",2],"nan":"NaN","ok":1.5}')
    expect(result[JSON_SCHEMA_KEY]).toBe(
      '{"properties":{"nested":{"properties":{"inf":{"type":"string"},"list":{"type":"array"},"nan":{"type":"string"},"ok":{"type":"number"}},"type":"object"}},"type":"object"}'
    )
  })

  test('sends an integer outside signed 64-bit range as its exact decimal string', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const result = serializeAttributes({
        // One past the int64 maximum, the first double the range check must reject.
        atBoundary: 2 ** 63,
        big: 2 ** 64,
        float: 1.5,
        negative: -(2 ** 64),
        safe: 9007199254740991,
      })

      expect(result).toEqual({
        atBoundary: '9223372036854775808',
        big: '18446744073709551616',
        float: 1.5,
        negative: '-18446744073709551616',
        safe: 9007199254740991,
      })
      // Warned once per process, not per attribute, unlike Python's per-call-site warning.
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('signed 64-bit'))
    } finally {
      warn.mockRestore()
    }
  })

  test('keeps an attribute whose key is an Object.prototype member', () => {
    // An object literal cannot make an own `__proto__` key; user data built by `Object.fromEntries`
    // or `JSON.parse` can. The scrubber used to assign it into its rebuilt record, which replaced
    // that record's prototype and lost the attribute.
    const result = serializeAttributes(
      Object.fromEntries<unknown>([
        ['__proto__', { a: 1 }],
        ['ok', 2],
      ])
    )

    expect(Object.hasOwn(result, '__proto__')).toBe(true)
    expect(result['__proto__']).toBe('{"a":1}')
    expect(result['ok']).toBe(2)
    expect(result[JSON_SCHEMA_KEY]).toBe(
      '{"properties":{"__proto__":{"properties":{"a":{"type":"number"}},"type":"object"}},"type":"object"}'
    )
  })

  test('keeps a __proto__ property nested inside an attribute value, and its schema', () => {
    const result = serializeAttributes({
      payload: Object.fromEntries([
        ['__proto__', 1],
        ['b', 'x'],
      ]),
    })

    expect(result['payload']).toBe('{"__proto__":1,"b":"x"}')
    expect(result[JSON_SCHEMA_KEY]).toBe(
      '{"properties":{"payload":{"properties":{"__proto__":{"type":"number"},"b":{"type":"string"}},"type":"object"}},"type":"object"}'
    )
  })

  test('emits deterministic nested object schema for ordinary JSON-like values', () => {
    const result = serializeAttributes({
      payload: {
        count: 2,
        meta: { active: true },
        name: 'Ada',
      },
    })

    expect(result['payload']).toBe('{"count":2,"meta":{"active":true},"name":"Ada"}')
    expect(result[JSON_SCHEMA_KEY]).toBe(
      '{"properties":{"payload":{"properties":{"count":{"type":"number"},"meta":{"properties":{"active":{"type":"boolean"}},"type":"object"},"name":{"type":"string"}},"type":"object"}},"type":"object"}'
    )
  })

  test('supports rich, basic, and disabled schema modes', () => {
    expect(parseSchema(serializeAttributes({ payload: { id: '123' } }))).toEqual({
      properties: {
        payload: {
          properties: {
            id: { type: 'string' },
          },
          type: 'object',
        },
      },
      type: 'object',
    })

    configureLogfireApi({ jsonSchema: 'basic' })
    expect(parseSchema(serializeAttributes({ payload: { id: '123' } }))).toEqual({
      properties: {
        payload: { type: 'object' },
      },
      type: 'object',
    })

    configureLogfireApi({ jsonSchema: false })
    expect(serializeAttributes({ payload: { id: '123' } })).not.toHaveProperty(JSON_SCHEMA_KEY)
  })

  test('emits Date schema for top-level and nested dates', () => {
    const createdAt = new Date('2026-01-02T03:04:05.000Z')
    const result = serializeAttributes({
      createdAt,
      payload: {
        createdAt,
      },
    })

    expect(result['createdAt']).toBe('2026-01-02T03:04:05.000Z')
    expect(result['payload']).toBe('{"createdAt":"2026-01-02T03:04:05.000Z"}')
    expect(parseSchema(result)).toEqual({
      properties: {
        createdAt: { format: 'date-time', type: 'string' },
        payload: {
          properties: {
            createdAt: { format: 'date-time', type: 'string' },
          },
          type: 'object',
        },
      },
      type: 'object',
    })
  })

  test('follows JSON.stringify visibility for nested undefined, function, and symbol values', () => {
    const result = serializeAttributes({
      array: [undefined, () => undefined, Symbol('hidden')],
      payload: {
        dropFunction: () => undefined,
        dropSymbol: Symbol('hidden'),
        dropUndefined: undefined,
        keep: true,
      },
    })

    expect(result['payload']).toBe('{"keep":true}')
    expect(result['array']).toBe('[null,null,null]')
    expect(parseSchema(result)).toEqual({
      properties: {
        array: {
          items: { type: 'null' },
          type: 'array',
        },
        payload: {
          properties: {
            keep: { type: 'boolean' },
          },
          type: 'object',
        },
      },
      type: 'object',
    })
  })

  test('covers homogeneous arrays and falls back for heterogeneous arrays', () => {
    const result = serializeAttributes({
      heterogeneous: [1, 'two'],
      objects: [{ id: 'a' }, { id: 'b' }],
      strings: ['a', 'b'],
    })

    expect(parseSchema(result)).toEqual({
      properties: {
        heterogeneous: { type: 'array' },
        objects: {
          items: {
            properties: {
              id: { type: 'string' },
            },
            type: 'object',
          },
          type: 'array',
        },
        strings: {
          items: { type: 'string' },
          type: 'array',
        },
      },
      type: 'object',
    })
  })

  test('keeps schema inference bounded by depth, object properties, and array samples', () => {
    const manyProperties: Record<string, number> = {}
    for (let index = 0; index < 25; index++) {
      manyProperties[`k${index.toString().padStart(2, '0')}`] = index
    }

    const result = serializeAttributes({
      array: [...Array.from({ length: 20 }, () => 'sampled'), 123],
      deep: { a: { b: { c: { d: { e: 'too deep' } } } } },
      manyProperties,
    })
    const schema = parseSchema(result) as {
      properties: {
        array: unknown
        deep: unknown
        manyProperties: { properties: Record<string, unknown> }
      }
    }

    expect(schema.properties.array).toEqual({
      items: { type: 'string' },
      type: 'array',
    })
    expect(schema.properties.deep).toEqual({
      properties: {
        a: {
          properties: {
            b: {
              properties: {
                c: {
                  properties: {
                    d: { type: 'object' },
                  },
                  type: 'object',
                },
              },
              type: 'object',
            },
          },
          type: 'object',
        },
      },
      type: 'object',
    })
    expect(Object.keys(schema.properties.manyProperties.properties)).toHaveLength(20)
    expect(schema.properties.manyProperties.properties).toHaveProperty('k00')
    expect(schema.properties.manyProperties.properties).toHaveProperty('k19')
    expect(schema.properties.manyProperties.properties).not.toHaveProperty('k20')
  })

  test('uses broad schemas for unsupported object-like values', () => {
    class CustomValue {
      value = 'custom'
    }

    const result = serializeAttributes({
      custom: new CustomValue(),
      map: new Map([['key', 'value']]),
      set: new Set(['value']),
    })

    expect(result['custom']).toBe('{"value":"custom"}')
    expect(result['map']).toBe('{}')
    expect(result['set']).toBe('{}')
    expect(parseSchema(result)).toEqual({
      properties: {
        custom: { type: 'object' },
        map: { type: 'object' },
        set: { type: 'object' },
      },
      type: 'object',
    })
  })

  test('does not throw when object or array serialization fails', () => {
    const circular: Record<string, unknown> = { password: 'secret-value' }
    circular['self'] = circular
    const circularArray: unknown[] = []
    circularArray.push(circularArray)

    const result = serializeAttributes({
      bigintPayload: { value: 1n },
      circular,
      circularArray,
      handler: () => undefined,
      symbol: Symbol('top-level'),
    })

    // A BigInt is representable now, so it no longer stands in for a serialization failure here;
    // `handler` and `symbol` below still cover the graceful-degradation guarantee this test exists for.
    expect(result['bigintPayload']).toBe('{"value":"1"}')
    expect(result['circular']).toBe('{"password":"[Scrubbed due to \'password\']","self":"[Scrubbed due to cycle]"}')
    expect(result['circularArray']).toBe('["[Scrubbed due to cycle]"]')
    expect(result['handler']).toBe('[unserializable]')
    expect(result['symbol']).toBe('[unserializable]')
  })

  test('sends a BigInt attribute as its exact decimal string at any depth', () => {
    const result = serializeAttributes({
      big: 12345678901234567890n,
      nested: { id: 99n, name: 'row' },
      small: 7n,
    })

    // These used to be `[unserializable]`, and the nested one took the whole attribute with it.
    expect(result['big']).toBe('12345678901234567890')
    expect(result['small']).toBe('7')
    expect(result['nested']).toBe('{"id":"99","name":"row"}')
    expect(result[JSON_SCHEMA_KEY]).toBe(
      '{"properties":{"nested":{"properties":{"id":{"type":"string"},"name":{"type":"string"}},"type":"object"}},"type":"object"}'
    )
  })

  test('does not throw for deeply nested attributes before JSON serialization', () => {
    let deep: Record<string, unknown> = { value: 'ok' }
    for (let index = 0; index < 10_000; index++) {
      deep = { child: deep }
    }

    const result = serializeAttributes({ deep })

    expect(result).toHaveProperty('deep')
    expect(result['deep']).toContain('[Scrubbed due to max depth]')
  })

  test('uses scrubbed values for schema inference', () => {
    const result = serializeAttributes({
      payload: {
        password: 'secret-value',
      },
    })

    expect(result['payload']).toBe('{"password":"[Scrubbed due to \'password\']"}')
    expect(parseSchema(result)).toMatchObject({
      properties: {
        payload: {
          properties: {
            password: { type: 'string' },
          },
          type: 'object',
        },
      },
      type: 'object',
    })
  })
})
