import { describe, expect, it } from 'vite-plus/test'

import { mergeSettings } from '../index'

describe('mergeSettings', () => {
  it('applies code < published < the values a run passed explicitly', () => {
    const { settings, sources } = mergeSettings(
      { temperature: 0.2, max_tokens: 1024 },
      { temperature: 0.8, top_p: 0.9 },
      { max_tokens: 4096 }
    )
    expect(settings).toEqual({ temperature: 0.8, max_tokens: 4096, top_p: 0.9 })
    expect(sources.get('temperature')).toBe('published')
    expect(sources.get('top_p')).toBe('published')
    expect(sources.get('max_tokens')).toBe('run')
  })

  it('lets a run keep a value the published config would otherwise have taken from it', () => {
    // The case diffing effective settings cannot see: code 0.2, published 0.8, and a run that passes
    // 0.2 explicitly looks exactly like a run that passed nothing, so the published value wins a key
    // the caller overrode. Only the explicit key set at the call boundary tells them apart.
    const { settings, sources } = mergeSettings({ temperature: 0.2 }, { temperature: 0.8 }, { temperature: 0.2 })
    expect(settings['temperature']).toBe(0.2)
    expect(sources.get('temperature')).toBe('run')
  })

  it('reads code and published as patches, so an unset key there does not erase the layer under it', () => {
    const { settings, sources } = mergeSettings({ temperature: 0.2 }, { temperature: undefined, top_p: null })
    expect(settings).toEqual({ temperature: 0.2 })
    expect(sources.get('temperature')).toBe('code')
    expect(sources.has('top_p')).toBe(false)
  })

  it('lets a run clear a key, which is not the same as never setting it', () => {
    const { settings, sources } = mergeSettings({ temperature: 0.2 }, {}, { temperature: undefined })
    expect('temperature' in settings).toBe(false)
    // "Send no value for this" -- which an adapter has to be able to tell from "whatever the
    // framework does by default", and only `sources` carries that difference.
    expect(sources.get('temperature')).toBe('run')
  })

  it('passes a key outside the canonical eleven through with its provenance', () => {
    const { settings, sources } = mergeSettings({ openai_service_tier: 'flex' })
    expect(settings).toEqual({ openai_service_tier: 'flex' })
    expect(sources.get('openai_service_tier')).toBe('code')
  })

  it('merges nothing into nothing', () => {
    const { settings, sources } = mergeSettings()
    expect(settings).toEqual({})
    expect(sources.size).toBe(0)
  })

  it('keeps a `__proto__` key as an entry rather than letting it become a prototype', () => {
    // The published layer comes from JSON, where `__proto__` parses as an ordinary own key. On a
    // plain object `settings[key] =` would have replaced the prototype instead, so `sources` would
    // report a key the merged patch does not carry -- and the run would silently not get it.
    const published = JSON.parse('{"__proto__": 1, "temperature": 0.5}') as Record<string, unknown>
    const { settings, sources } = mergeSettings({ temperature: 0.1 }, published)
    expect(Object.hasOwn(settings, '__proto__')).toBe(true)
    expect(settings['__proto__']).toBe(1)
    expect(sources.get('__proto__')).toBe('published')
  })

  it('clears a `__proto__` key a run explicitly unset, like any other', () => {
    const published = JSON.parse('{"__proto__": 1}') as Record<string, unknown>
    const runExplicit = JSON.parse('{"__proto__": null}') as Record<string, unknown>
    const { settings, sources } = mergeSettings(undefined, published, runExplicit)
    expect(Object.hasOwn(settings, '__proto__')).toBe(false)
    expect(sources.get('__proto__')).toBe('run')
  })
})
