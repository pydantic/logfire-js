import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vite-plus/test'

import { AGENT_CONFIG_JSON_SCHEMA, canonicalJson, MAX_MODEL_FACING_TEXT_LENGTH, SCHEMA_SHA256 } from '../index'

describe('AGENT_CONFIG_JSON_SCHEMA', () => {
  it('hashes to the digest every SDK pins', () => {
    // The whole point of the constant: this package's literal and the Python one are provably the
    // same document, so a variable created by either side is editable by the same Logfire UI.
    const digest = createHash('sha256').update(canonicalJson(AGENT_CONFIG_JSON_SCHEMA)).digest('hex')
    expect(digest).toBe(SCHEMA_SHA256)
    expect(digest).toBe('e4c38488d6c46440dbf31939291e13fcd56814c1305bc9012cd2158733b0bbad')
  })

  it('is permissive about keys it does not name', () => {
    // An `additionalProperties: false` anywhere would reject a key a newer UI writes at write time,
    // which defeats the leniency every reader is built around.
    const found: string[] = []
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => {
          walk(item, `${path}[${String(index)}]`)
        })
        return
      }
      if (typeof node !== 'object' || node === null) {
        return
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === 'additionalProperties' && value === false) {
          found.push(path)
        }
        walk(value, `${path}.${key}`)
      }
    }
    walk(AGENT_CONFIG_JSON_SCHEMA, '$')
    expect(found).toEqual([])
  })

  it('caps model-facing text at the shared limit', () => {
    expect(MAX_MODEL_FACING_TEXT_LENGTH).toBe(65_536)
    expect(canonicalJson(AGENT_CONFIG_JSON_SCHEMA)).toContain('"maxLength":65536')
  })
})

describe('canonicalJson', () => {
  it('sorts object keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: null } })).toBe('{"a":{"c":null,"d":[3,1,2]},"b":1}')
  })

  it('passes scalars through', () => {
    expect(canonicalJson('x')).toBe('"x"')
    expect(canonicalJson(null)).toBe('null')
  })
})
