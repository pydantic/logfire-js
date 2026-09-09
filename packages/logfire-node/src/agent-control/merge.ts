/**
 * Merging code, published, and per-run settings, and remembering which layer won each key.
 *
 * The contract's precedence is one sentence -- code < published < the values a run passed explicitly
 * -- and three adapters have now implemented it by *diffing* the framework's effective settings
 * against the agent's own to guess which keys the run asked for. That guess is wrong in exactly the
 * case that matters: code `temperature: 0.2`, published `0.8`, and a run that passes `0.2`
 * explicitly is indistinguishable from a run that passed nothing, so the published value wins a key
 * the caller overrode. It cannot be fixed by diffing harder, only by capturing the explicit keys at
 * the boundary that has them and merging with that knowledge, which is what this module takes in.
 */

/**
 * Which layer a merged setting's value came from.
 *
 * `'code'` is the agent as written, `'published'` is the managed config, and `'run'` is a value the
 * caller passed explicitly for this one run. They are ordered: a later layer overrides an earlier
 * one, and nothing else does.
 */
export type SettingSource = 'code' | 'published' | 'run'

/**
 * A merged settings patch, and which layer each key came from.
 *
 * The provenance is not decoration. An adapter that has to lower one merged value into a
 * provider-specific place -- `providerOptions.openai.parallelToolCalls`, a request timeout composed
 * with a caller's own deadline -- needs to know whether the value it is about to write came from the
 * run or from the published config, because those two want opposite treatment: a run's value
 * replaces what is there, a published one must not stamp over a run's.
 */
export interface Provenance {
  /** The merged patch: every key that has a value, with the winning layer's value. */
  readonly settings: Record<string, unknown>
  /**
   * The winning layer per key mentioned by any layer.
   *
   * A superset of `settings`'s keys: a key here but not there is one a run explicitly *cleared*,
   * which an adapter has to be able to tell from a key nobody ever set -- the first means "send no
   * value for this", the second means "whatever the framework does by default".
   *
   * A `Map` rather than an object because the keys come from a framework's settings and, through the
   * published layer, from JSON: `sources['constructor']` on a plain object answers about
   * `Object.prototype`, and no lookup here should ever be able to.
   */
  readonly sources: ReadonlyMap<string, SettingSource>
}

/** One layer's settings, or nothing when that layer has none. */
export type SettingsLayer = Readonly<Record<string, unknown>> | null | undefined

/**
 * Merge the three settings layers in contract order, keeping a record of who won.
 *
 * Each argument is a flat mapping of that layer's settings. `code` and `published` are read as
 * patches, so an `undefined` or `null` value in them is "this layer does not set that key" and is
 * skipped: neither layer has any way to express "explicitly no value", and treating one there as
 * such would let a framework that spells its unset settings out as `undefined` erase the layer under
 * it.
 *
 * `runExplicit` is different, and it is the whole reason this function exists: it holds only the keys
 * the caller set *at the call site for this run*, so an `undefined` in it is a deliberate "send no
 * value for this key" and clears whatever the layers under it had. An adapter that cannot see which
 * keys a run set explicitly -- a hook handed one already-merged settings object -- should pass
 * nothing here and document the weaker contract rather than diff its way to a guess.
 *
 * Keys outside the contract's canonical eleven pass through untouched, so an adapter can merge its
 * framework's whole settings object rather than splitting the canonical keys out first: a
 * provider-specific key only `code` carries simply survives with `'code'` provenance.
 */
export function mergeSettings(code?: SettingsLayer, published?: SettingsLayer, runExplicit?: SettingsLayer): Provenance {
  const settings: Record<string, unknown> = {}
  const sources = new Map<string, SettingSource>()
  for (const [layer, source] of [
    [code, 'code'],
    [published, 'published'],
  ] as const) {
    for (const [key, value] of Object.entries(layer ?? {})) {
      if (value === undefined || value === null) {
        continue
      }
      settings[key] = value
      sources.set(key, source)
    }
  }
  for (const [key, value] of Object.entries(runExplicit ?? {})) {
    sources.set(key, 'run')
    // `Reflect.deleteProperty` rather than `delete settings[key]`: the key comes from a caller's
    // settings object, and a computed `delete` is what the repository's lint rules keep out.
    if (value === undefined || value === null) {
      Reflect.deleteProperty(settings, key)
    } else {
      settings[key] = value
    }
  }
  return { settings, sources }
}
