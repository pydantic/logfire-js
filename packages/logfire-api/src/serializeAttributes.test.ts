import { beforeEach, describe, expect, test } from 'vite-plus/test'

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
    const circular: Record<string, unknown> = {}
    circular['self'] = circular

    const result = serializeAttributes({
      bigintPayload: { value: 1n },
      circular,
      handler: () => undefined,
      symbol: Symbol('top-level'),
    })

    expect(result).toEqual({
      bigintPayload: '[unserializable]',
      circular: '[unserializable]',
      handler: '[unserializable]',
      symbol: '[unserializable]',
    })
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
