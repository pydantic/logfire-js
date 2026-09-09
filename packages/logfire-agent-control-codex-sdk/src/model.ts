/**
 * Translating between the contract's `provider:model` string and Codex's two separate fields.
 *
 * Codex takes a bare model slug (`gpt-5.6-sol`) plus a `model_provider` id that indexes into the
 * user's `model_providers` table in `config.toml`. The contract's `model` is one string, so an
 * adapter is where the two halves come apart and go back together.
 */

/** A model as Codex takes it: the slug, and the provider id it is looked up under. */
export interface CodexModel {
  /** The bare model slug, e.g. `gpt-5.6-sol`. */
  model: string
  /** The `model_provider` id, or `undefined` to leave whatever the user's config says in place. */
  provider: string | undefined
}

/**
 * Split a contract `model` string into Codex's model slug and provider id.
 *
 * Split at the *first* colon, because a provider id never contains one while a model slug can
 * (`openrouter:openai/gpt-5` is one provider and one slug, and some gateways use colons in slugs).
 *
 * A string with nothing on one side of the colon is not a provider-qualified model, whatever it was
 * meant to be, so it is passed through as a bare slug: Codex then fails on an unknown model, which
 * says what happened, rather than this silently resolving a provider id of `''`.
 */
export function splitModel(model: string): CodexModel {
  const colon = model.indexOf(':')
  if (colon === -1) {
    return { model, provider: undefined }
  }
  const provider = model.slice(0, colon)
  const slug = model.slice(colon + 1)
  if (provider === '' || slug === '') {
    return { model, provider: undefined }
  }
  return { model: slug, provider }
}

/**
 * Join Codex's two fields back into the contract's `model` string for a baseline.
 *
 * A model whose provider the code does not pin comes back as a bare slug, because that is all this
 * package knows. Codex resolves an unqualified model against the `model_provider` in a `config.toml`
 * on the machine the agent runs on, which is not a file the SDK reads -- so naming `openai` here
 * would put an identity in front of the editor that the run need not have, and a published value
 * echoing it back would then *change* the provider it was only meant to describe. A bare slug
 * round-trips instead: publishing it leaves whatever the machine resolves alone.
 */
export function joinModel({ model, provider }: CodexModel): string {
  return provider === undefined ? model : `${provider}:${model}`
}
