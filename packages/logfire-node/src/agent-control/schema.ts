/**
 * The stored JSON schema for an `agent__<name>` variable, and the digest that pins it.
 *
 * This module is a contract, not code that does anything: the schema below is byte-for-byte the one
 * the reference implementation stores, so a variable created by this package and one created by the
 * Python SDK or the Logfire UI are the same object.
 */

/**
 * The cap on any single piece of text a managed config can put in front of a model.
 *
 * 64 KiB of text is already roughly 16K tokens for typical English prose. It accommodates
 * substantial instructions while preventing one managed entry from adding megabytes to every model
 * request.
 */
export const MAX_MODEL_FACING_TEXT_LENGTH = 65_536

/**
 * The length of `text` in Unicode code points, which is what the budget is counted in.
 *
 * Deliberately not `String.length`, which counts UTF-16 code units and would give an emoji or a CJK
 * extension character twice the weight the Python core gives it -- so the same published value would
 * fit one core's budget and not the other's. `[...text].length` iterates code points, which is what
 * Python's `len` counts.
 */
export function codePointLength(text: string): number {
  // Spreading a string is exactly what is wanted here, and exactly what the lint rule warns about:
  // it splits into code points rather than grapheme clusters. Code points are the unit the
  // cross-language budget is stated in, so this is the counting rule, not a bug in it.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- code points are the unit here.
  return [...text].length
}

/** A JSON Schema document, as the Logfire variables API stores and returns it. */
export type JsonSchema = Record<string, unknown>

/**
 * The stored JSON schema for an `agent__<name>` variable, shared with the Logfire Agent Control UI.
 *
 * The Logfire UI holds a copy of this, and whichever side creates the variable first is the one
 * whose schema is persisted. The schema is not cosmetic: the Logfire backend validates every new
 * version of the value against it, so anything this schema rejects cannot be written at all. That is
 * also why it is maintained by hand rather than generated from the Zod types in `./config.ts` --
 * generated output describes *this* release on *this* Zod version, while the stored schema is a
 * long-lived contract between a Logfire project and every SDK version that will ever write to it.
 *
 * It is permissive at every level for the same reason `parseAgentConfig` is lenient: an
 * `additionalProperties: false` anywhere would reject a key a newer UI writes at *write* time, which
 * is worse than an older SDK ignoring it at read time. For the same reason the fields whose accepted
 * values grow from release to release (`thinking`) are typed rather than enumerated, and `settings`
 * names the canonical keys for the editor's benefit while leaving unnamed ones writable.
 *
 * The constraints it does keep are structural rather than versioned, and each one closes a hole a
 * permissive schema would otherwise leave open. Every `minLength: 1` says that `''` is a half-filled
 * field, never a value, and `model: ''` in particular takes an agent down on every request.
 * `tool_definitions` items require a `name` because an overlay that names no tool cannot be applied
 * to anything, so accepting it would only let the UI save a row that silently does nothing.
 *
 * Any edit here changes the contract and must be made in every SDK at once; `SCHEMA_SHA256` is what
 * makes an accidental one fail a test instead of reaching a project.
 */
export const AGENT_CONFIG_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    instructions: {
      description:
        'Instruction blocks added to the ones the agent assembles in code, not a replacement for ' +
        'them. A bare string is one added block. An entry with an `id` swaps out the block the ' +
        'agent already sends under that key instead of adding one.',
      anyOf: [
        {
          type: 'string',
          minLength: 1,
          maxLength: MAX_MODEL_FACING_TEXT_LENGTH,
        },
        {
          type: 'array',
          items: {
            anyOf: [
              {
                type: 'string',
                minLength: 1,
                maxLength: MAX_MODEL_FACING_TEXT_LENGTH,
              },
              {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    minLength: 1,
                    description:
                      'The id of the instruction block to address, as the baseline lists it. Omit to add a ' +
                      'block instead. A block the baseline marks dynamic cannot be addressed: replacing it ' +
                      'would pin one rendering and dropping it would remove the computation, so either is ' +
                      'ignored.',
                  },
                  instructions: {
                    anyOf: [
                      {
                        type: 'string',
                        minLength: 1,
                        maxLength: MAX_MODEL_FACING_TEXT_LENGTH,
                      },
                      {
                        type: 'null',
                      },
                    ],
                    description: 'The text to send, or null to drop the addressed block.',
                  },
                  dynamic: {
                    type: 'boolean',
                    description:
                      'Whether the block is recomputed per request. Set on the code-side baseline and ignored ' +
                      'on input -- but a block marked true is not addressable, so an editor should offer no ' +
                      'override for it.',
                  },
                },
              },
            ],
          },
        },
      ],
    },
    model: {
      type: 'string',
      minLength: 1,
      description: "A model string in 'provider:model' form, such as 'anthropic:claude-fable-5-1'.",
    },
    settings: {
      type: 'object',
      description: 'Model settings patch. Only the keys named here are applied; a key an SDK does not know is ignored.',
      properties: {
        max_tokens: {
          type: 'integer',
        },
        temperature: {
          type: 'number',
        },
        top_p: {
          type: 'number',
        },
        top_k: {
          type: 'integer',
        },
        seed: {
          type: 'integer',
        },
        presence_penalty: {
          type: 'number',
        },
        frequency_penalty: {
          type: 'number',
        },
        parallel_tool_calls: {
          type: 'boolean',
        },
        timeout: {
          type: 'number',
        },
        stop_sequences: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
        thinking: {
          anyOf: [
            {
              type: 'boolean',
            },
            {
              type: 'string',
            },
          ],
          description: "Enabled/disabled, or an effort level: 'minimal', 'low', 'medium', 'high', 'xhigh'.",
        },
      },
    },
    tool_definitions: {
      type: 'array',
      description:
        'LLM-facing overlays, each naming the tool it patches by its code-side name. Parameter ' +
        'names, types, requiredness, validation, and implementation stay code-defined. The ' +
        'baseline also says which `toolset` each tool came from.',
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            description: "The tool's code-side name, which is what this entry patches.",
          },
          new_name: {
            type: 'string',
            minLength: 1,
            description: 'Name shown to the model; a call to it routes back to the original tool.',
          },
          description: {
            type: 'string',
          },
          parameters: {
            type: 'object',
            description: 'Patches per top-level parameter name.',
            additionalProperties: {
              type: 'object',
              properties: {
                description: {
                  type: 'string',
                },
              },
            },
          },
          toolset: {
            type: 'string',
            description:
              'The toolset the tool came from: the baseline reports it, and on an override it narrows ' +
              "the match to that toolset's tool of this name.",
          },
        },
      },
    },
  },
}

/**
 * The SHA-256 of `AGENT_CONFIG_JSON_SCHEMA` in its canonical form.
 *
 * Canonical means the JSON with object keys sorted recursively and no whitespace, which is exactly
 * Python's `json.dumps(schema, sort_keys=True, separators=(',', ':'))`. Sorting is what makes the
 * digest comparable across SDKs: neither side's literal has to be written in the other's key order
 * for the two to be provably the same document.
 *
 * It is a constant rather than something computed at import time so that a change to the schema
 * shows up as a diff on this line -- a value someone has to look at and update deliberately --
 * instead of silently agreeing with itself.
 */
export const SCHEMA_SHA256 = 'e4c38488d6c46440dbf31939291e13fcd56814c1305bc9012cd2158733b0bbad'

/**
 * Serialize a JSON value with object keys sorted recursively and no whitespace.
 *
 * `JSON.stringify` preserves insertion order and offers no way to sort nested keys, so the canonical
 * form has to be built by hand. Arrays keep their order -- it is part of the value -- and only
 * objects are reordered.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys)
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  // `Object.entries` already hands back a fresh array, so sorting it in place mutates nothing the
  // caller holds. An object cannot hold one key twice, so the comparator has no equal case to answer for.
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
  return Object.fromEntries(entries.map(([key, item]) => [key, sortKeys(item)]))
}
