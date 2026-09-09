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
})
