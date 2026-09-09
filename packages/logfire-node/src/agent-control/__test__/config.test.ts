import { describe, expect, it } from 'vite-plus/test'

import { CANONICAL_SETTINGS_KEYS, canonicalSettings, parseAgentConfig } from '../index'
import { UNRECOGNIZED_SETTINGS } from '../config'
import { captureWarnings } from './helpers'

const warnings = captureWarnings()

describe('parseAgentConfig', () => {
  it('keeps a fully valid value as written', () => {
    const value = {
      instructions: ['Be brief.', { id: 'agent', instructions: 'You are a checkout assistant.' }],
      model: 'anthropic:claude-fable-5-1',
      settings: { temperature: 0.2, thinking: 'high', stop_sequences: ['STOP'] },
      tool_definitions: [{ name: 'search', new_name: 'find', parameters: { q: { description: 'Query.' } } }],
    }
    // A string *inside the list* is normalized to the entry it is shorthand for, so every consumer
    // sees one shape. Only the bare-string *section* keeps its shape; see the next test.
    expect(parseAgentConfig(value)).toEqual({
      ...value,
      instructions: [{ instructions: 'Be brief.' }, { id: 'agent', instructions: 'You are a checkout assistant.' }],
    })
    expect(warnings.messages).toEqual([])
  })

  it('keeps a bare instructions string in the shape its author wrote', () => {
    expect(parseAgentConfig({ instructions: 'Be brief.' })).toEqual({ instructions: 'Be brief.' })
  })

  it('leaves absent sections absent, so nothing is managed by accident', () => {
    expect(parseAgentConfig({})).toEqual({})
  })

  it('returns an empty config for a value that is not an object', () => {
    expect(parseAgentConfig(['not', 'a', 'config'])).toEqual({})
    expect(warnings.messages).toEqual(['Managed agent config is not an object -- ["not","a","config"]; ignoring it and running on code.'])
  })

  it('returns an empty config silently for a missing value', () => {
    expect(parseAgentConfig(undefined)).toEqual({})
    expect(parseAgentConfig(null)).toEqual({})
    expect(warnings.messages).toEqual([])
  })

  describe('instructions', () => {
    it('drops an invalid entry and keeps its siblings', () => {
      const config = parseAgentConfig({ instructions: ['Keep me.', '', { id: 'agent' }] })
      expect(config.instructions).toEqual([{ instructions: 'Keep me.' }, { id: 'agent' }])
      expect(warnings.messages).toHaveLength(1)
      expect(warnings.messages[0]).toContain("Managed instruction entry '' is invalid -- instructions=''")
      expect(warnings.messages[0]).toContain('keeping the rest of the managed config')
    })

    it('drops an entry that says neither what nor where', () => {
      expect(parseAgentConfig({ instructions: [{ dynamic: true }] }).instructions).toEqual([])
      expect(warnings.messages[0]).toContain('has neither an `id` to address nor text to add')
    })

    it('drops an entry that is not a string or an object', () => {
      expect(parseAgentConfig({ instructions: [42, 'Keep me.'] }).instructions).toEqual([{ instructions: 'Keep me.' }])
      expect(warnings.messages[0]).toContain('Managed instruction entry 42 is invalid -- entry=42')
    })

    it('drops a section that is not a string or a list', () => {
      expect(parseAgentConfig({ instructions: { id: 'agent' } }).instructions).toBeUndefined()
      expect(warnings.messages[0]).toContain('Managed instructions section has invalid container')
    })

    it('ignores an absent section without a word', () => {
      expect(parseAgentConfig({ instructions: null }).instructions).toBeUndefined()
      expect(warnings.messages).toEqual([])
    })

    it('drops an empty section string', () => {
      expect(parseAgentConfig({ instructions: '' }).instructions).toBeUndefined()
      expect(warnings.messages[0]).toContain("Managed instructions section is invalid -- instructions=''")
    })

    it('drops a section string past the model-facing limit', () => {
      expect(parseAgentConfig({ instructions: 'x'.repeat(65_537) }).instructions).toBeUndefined()
      expect(warnings.messages[0]).toContain('contains 65537 characters, exceeding the 65536-character limit')
    })

    it('caps the total across entries, not just each one', () => {
      const config = parseAgentConfig({
        instructions: ['x'.repeat(65_000), 'y'.repeat(1_000), 'fits'],
      })
      expect(config.instructions).toEqual([{ instructions: 'x'.repeat(65_000) }, { instructions: 'fits' }])
      expect(warnings.messages[0]).toContain('does not fit in the 536 remaining of the 65536-character limit')
    })

    it('strips a key the contract does not define', () => {
      expect(parseAgentConfig({ instructions: [{ instructions: 'Hi.', nonsense: 1 }] }).instructions).toEqual([{ instructions: 'Hi.' }])
    })
  })

  describe('model', () => {
    it("drops an empty model rather than taking the agent down with a model named ''", () => {
      expect(parseAgentConfig({ model: '', instructions: 'Kept.' })).toEqual({
        instructions: 'Kept.',
      })
      expect(warnings.messages[0]).toContain("Managed agent config selects invalid model ''")
    })

    it('ignores an absent model without a word', () => {
      expect(parseAgentConfig({ model: null }).model).toBeUndefined()
      expect(warnings.messages).toEqual([])
    })
  })

  describe('settings', () => {
    it('drops one malformed value and keeps its siblings', () => {
      const config = parseAgentConfig({ settings: { temperature: 'warm', max_tokens: 100 } })
      expect(config.settings).toEqual({ max_tokens: 100 })
      expect(warnings.messages[0]).toContain("Managed agent config setting 'temperature' has invalid value 'warm'")
    })

    it('drops a value a newer SDK would know, with its own message', () => {
      const config = parseAgentConfig({ settings: { thinking: 'xxhigh', seed: 7 } })
      expect(config.settings).toEqual({ seed: 7 })
      expect(warnings.messages[0]).toContain(
        "Managed agent config sets 'thinking' to 'xxhigh', which this version of the SDK does not recognize"
      )
    })

    it('remembers an unrecognized key instead of dropping it silently', () => {
      const config = parseAgentConfig({ settings: { service_tier: 'flex', temperature: 0 } })
      expect(config.settings).toEqual({ temperature: 0 })
      expect(config.settings?.[UNRECOGNIZED_SETTINGS]).toEqual(['service_tier'])
      // Reported by `applySettings`, where it is applied, not here -- see `reportUnmatched`.
      expect(warnings.messages).toEqual([])
    })

    it('drops a section that is not an object', () => {
      expect(parseAgentConfig({ settings: [1] }).settings).toBeUndefined()
      expect(warnings.messages[0]).toContain('Managed settings section has invalid container [1]')
    })

    it('ignores an absent section without a word', () => {
      expect(parseAgentConfig({ settings: null }).settings).toBeUndefined()
      expect(warnings.messages).toEqual([])
    })

    it('names every canonical key exactly once', () => {
      expect([...CANONICAL_SETTINGS_KEYS]).toEqual([
        'max_tokens',
        'temperature',
        'top_p',
        'top_k',
        'seed',
        'presence_penalty',
        'frequency_penalty',
        'parallel_tool_calls',
        'timeout',
        'stop_sequences',
        'thinking',
      ])
    })
  })

  describe('tool_definitions', () => {
    it('drops an override with no usable name and keeps its siblings', () => {
      const config = parseAgentConfig({ tool_definitions: [{ name: '' }, { name: 'search' }] })
      expect(config.tool_definitions).toEqual([{ name: 'search' }])
      expect(warnings.messages[0]).toContain('Managed tool definition override {"name":""} is invalid -- name=\'\'')
    })

    it('drops an entry that is not an object at all', () => {
      expect(parseAgentConfig({ tool_definitions: ['search'] }).tool_definitions).toEqual([])
      expect(warnings.messages[0]).toContain("override='search'")
    })

    it('drops a section that is not a list', () => {
      expect(parseAgentConfig({ tool_definitions: { name: 'search' } }).tool_definitions).toBeUndefined()
      expect(warnings.messages[0]).toContain('Managed tool definitions section has invalid container')
    })

    it('ignores an absent section without a word', () => {
      expect(parseAgentConfig({ tool_definitions: null }).tool_definitions).toBeUndefined()
      expect(warnings.messages).toEqual([])
    })
  })

  it('warns once per process per message, however many runs resolve the value', () => {
    for (let i = 0; i < 3; i++) {
      parseAgentConfig({ settings: { temperature: 'warm' } })
    }
    expect(warnings.messages).toHaveLength(1)
  })
})

describe('a settings key that names something on Object.prototype', () => {
  it('is unrecognized, not an inherited validator that throws the whole parse away', () => {
    // `PLAIN_SETTINGS['constructor']` on an object literal is `Object`, a function with no
    // `safeParse`, so looking a key up without an own-property check turned one odd JSON key into a
    // `TypeError` out of the parse -- which the SDK's resolution reads as "nothing is published" and
    // reverts instructions, model, settings, and every tool override to code along with it.
    // Parsed from JSON rather than written as a literal, because that is where such a key comes
    // from -- and because a literal's `__proto__` sets a prototype instead of becoming a key.
    const stored: unknown = JSON.parse(
      '{"settings": {"constructor": 1, "__proto__": {"temperature": 9}, "toString": "x", "temperature": 0.2},' +
        ' "model": "openai:gpt-5.6-sol"}'
    )
    const config = parseAgentConfig(stored)
    expect(config.model).toBe('openai:gpt-5.6-sol')
    expect(config.settings).toEqual({ temperature: 0.2 })
    expect(config.settings?.[UNRECOGNIZED_SETTINGS]).toEqual(['constructor', '__proto__', 'toString'])
    expect(warnings.messages).toEqual([])
  })

  it('cannot reach a validator through the prototype chain of the versioned table either', () => {
    const config = parseAgentConfig({ settings: { hasOwnProperty: 'thinking' } })
    expect(config.settings).toEqual({})
    expect(config.settings?.[UNRECOGNIZED_SETTINGS]).toEqual(['hasOwnProperty'])
  })
})

describe('canonicalSettings', () => {
  it('keeps the canonical keys and drops everything a baseline must not carry', () => {
    // Provider-specific keys and extra headers are where authorization headers live, and a baseline
    // is published to a variable every member of the project can read.
    expect(
      canonicalSettings({
        temperature: 0.2,
        max_tokens: 1024,
        extra_headers: { authorization: 'Bearer sk-secret' },
        openai_service_tier: 'flex',
        top_k: null,
        seed: undefined,
      })
    ).toEqual({ max_tokens: 1024, temperature: 0.2 })
    expect(warnings.messages).toEqual([])
  })

  it('omits a value the contract cannot hold, and says so, rather than approximating it', () => {
    // A framework's `'max'` effort is not `'xhigh'`. Publishing it as one describes the code as doing
    // something it does not do, in the one artifact the Logfire editor presents as the truth.
    expect(canonicalSettings({ thinking: 'max', temperature: 0.3 })).toEqual({ temperature: 0.3 })
    expect(warnings.messages).toEqual([
      "The agent runs with thinking='max', which the Agent Control contract cannot describe; leaving it " +
        'out of the published baseline.',
    ])
  })

  it('omits a timeout outside the representable range under its own message', () => {
    expect(canonicalSettings({ timeout: -1, max_tokens: 512 })).toEqual({ max_tokens: 512 })
    expect(warnings.messages[0]).toContain('The agent runs with a request timeout of -1 seconds')
  })

  it('emits the keys in contract order, so two SDKs publish the same bytes', () => {
    const settings = canonicalSettings({ thinking: 'high', temperature: 0.2, max_tokens: 8 })
    expect(Object.keys(settings)).toEqual(['max_tokens', 'temperature', 'thinking'])
    expect(CANONICAL_SETTINGS_KEYS.indexOf('max_tokens')).toBe(0)
  })
})
