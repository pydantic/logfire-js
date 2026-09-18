/**
 * One rule for turning an agent's name into the Logfire variable its config lives in.
 *
 * Both cores and the Logfire UI have to land on the same variable for the same agent, or a Pydantic
 * AI agent and a Mastra agent called `checkout-assistant` quietly hold two different configs while
 * the UI shows one. The rule is therefore stated once, here, with cross-language vectors in
 * `spec/agent-name.json`, rather than reimplemented per language.
 */

import { warnOnce } from './warnings'

/** The one naming rule the SDKs and the Logfire UI share: an agent's config lives at `agent__<key>`. */
export const AGENT_VARIABLE_PREFIX = 'agent__'

/**
 * Reduce an agent's display name to the key its variable is built from.
 *
 * Trim, lowercase, turn every character outside `[a-z0-9_]` into `_`, collapse runs of `_`, and
 * strip `_` from both ends. The result is the *key*, not the variable name; see `agentVariableName`.
 *
 * Lowercasing is the part worth justifying, because it is the lossy one. The rule exists to make two
 * SDKs agree with the Logfire UI, and the UI's own rule -- the one the Pydantic AI harness already
 * applies to an agent's telemetry name -- lowercases. Diverging from it would mean an agent named
 * `Checkout Assistant` in one service and `checkout_assistant` in another shows up as two configs in
 * a UI that only ever renders one name for them. It is lossy in the other direction too:
 * `checkout-assistant`, `Checkout Assistant`, and `checkout_assistant` are one key, so two genuinely
 * different agents whose names differ only in punctuation or case share a config. Give them
 * explicit, distinct names when that is not what you want.
 *
 * The character class is deliberately ASCII: `café` keys as `caf` and a name with no ASCII in it at
 * all keys as `''`. Transliterating instead would be a per-language table, which is the one thing a
 * cross-language rule cannot afford.
 *
 * Returns the empty string for a name with nothing usable in it -- whitespace, punctuation, or a
 * script with no ASCII in it -- which callers turn into an error rather than a variable.
 */
export function normalizeAgentName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]/gu, '_')
    .replaceAll(/_+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '')
}

/**
 * The Logfire variable holding the config for the agent called `name`.
 *
 * `agent__` plus `normalizeAgentName(name)`. The prefix is added here, so passing a name that
 * already carries it is a mistake the caller is warned about rather than one that produces
 * `agent__agent__checkout`.
 *
 * @throws If `name` has nothing a key can be made of.
 */
export function agentVariableName(name: string): string {
  let stripped = name.trim()
  if (stripped.toLowerCase().startsWith(AGENT_VARIABLE_PREFIX)) {
    warnOnce(`The '${AGENT_VARIABLE_PREFIX}' prefix is added automatically; pass the bare agent name rather than '${name}'.`)
    stripped = stripped.slice(AGENT_VARIABLE_PREFIX.length)
  }
  const key = normalizeAgentName(stripped)
  if (key === '') {
    throw new Error(
      `Agent name '${name}' has nothing a variable key can be made of. The config is stored under ` +
        '`agent__<key>`, where the key is the name lowercased with everything outside `[a-z0-9_]` turned ' +
        'into `_`, so a name has to contain at least one ASCII letter, digit, or underscore.'
    )
  }
  // `key` is a non-empty `[a-z0-9_]` string and the prefix starts with a letter, so the result is
  // always a valid identifier: there is nothing left here for a validity check to catch.
  return `${AGENT_VARIABLE_PREFIX}${key}`
}
