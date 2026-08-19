/* eslint-disable @typescript-eslint/require-await -- test stubs satisfy async signatures without awaiting. */
import { describe, expect, it } from 'vite-plus/test'

import { getBaseUrlFromToken } from '../tokenBaseUrl'
import { NoAnswerAvailableError } from './interactivePrompt'
import type { Prompt } from './interactivePrompt'
import { isCliRegion, promptForRegion, resolveSelectedBaseUrl } from './regions'

describe('CLI regions', () => {
  it('accepts public regions and rejects inherited object properties', () => {
    expect(isCliRegion('us')).toBe(true)
    expect(isCliRegion('eu')).toBe(true)
    expect(isCliRegion('toString')).toBe(false)
    expect(isCliRegion('constructor')).toBe(false)
    expect(isCliRegion('mars')).toBe(false)
  })

  it('resolves base URLs from region ids and explicit URLs', () => {
    expect(resolveSelectedBaseUrl(undefined, 'us')).toBe('https://logfire-us.pydantic.dev')
    expect(resolveSelectedBaseUrl(undefined, 'eu')).toBe('https://logfire-eu.pydantic.dev')
    expect(resolveSelectedBaseUrl('https://self-hosted.example.com/', undefined)).toBe('https://self-hosted.example.com')
    expect(resolveSelectedBaseUrl(undefined, undefined)).toBeUndefined()
    expect(() => resolveSelectedBaseUrl(undefined, 'constructor')).toThrow('Unknown Logfire region')
  })

  it('falls back to US for tokens whose region matches an inherited property', () => {
    // `constructor` is lowercase letters, so it matches the token regex's region group;
    // an own-property check keeps it from resolving to Object.prototype.constructor.
    expect(getBaseUrlFromToken('pylf_v1_constructor_abc123')).toBe('https://logfire-us.pydantic.dev')
    expect(getBaseUrlFromToken('pylf_v1_eu_abc123')).toBe('https://logfire-eu.pydantic.dev')
    expect(getBaseUrlFromToken(undefined)).toBe('https://logfire-us.pydantic.dev')
  })

  describe('promptForRegion', () => {
    it('resolves the base URL for the chosen region', async () => {
      const prompt = fakePrompt({ choice: async () => '2' })
      await expect(promptForRegion(prompt)).resolves.toBe('https://logfire-eu.pydantic.dev')
    })

    it('rejects a selection outside the numbered list', async () => {
      // `choice()` itself only ever returns a value from the list it was given, so this
      // path only fires if that contract is ever violated -- guards against a future
      // regression there, not something a real prompt implementation can trigger today.
      const prompt = fakePrompt({ choice: async () => '99' })
      await expect(promptForRegion(prompt)).rejects.toThrow('Invalid Logfire region selection.')
    })

    it('names the exact command to run for each region when there is no answer to read', async () => {
      // Mirrors pydantic/logfire#2275 ("let `logfire auth` complete without a TTY"): which
      // region holds your data is not the CLI's to guess, so this stays a hard stop -- but
      // one that says exactly what to run instead of hanging on a prompt nobody can answer.
      const prompt = fakePrompt({
        choice: async () => {
          throw new NoAnswerAvailableError()
        },
      })

      await expect(promptForRegion(prompt)).rejects.toThrow(
        [
          'Logfire is available in multiple data regions and no region was selected.',
          'Re-run in an interactive terminal to choose, or pass one:',
          '',
          '  logfire --region us auth',
          '  logfire --region eu auth',
        ].join('\n')
      )
    })

    it('lets an unrelated error from choice() propagate unchanged', async () => {
      const prompt = fakePrompt({
        choice: async () => {
          throw new Error('the terminal caught fire')
        },
      })

      await expect(promptForRegion(prompt)).rejects.toThrow('the terminal caught fire')
    })
  })
})

function fakePrompt(overrides: Partial<Prompt>): Prompt {
  return {
    choice: async (_message, choices, defaultChoice) => defaultChoice ?? choices[0] ?? '',
    confirm: async (_message, defaultYes = true) => defaultYes,
    text: async (_message, defaultValue) => defaultValue ?? '',
    waitForEnter: async () => undefined,
    ...overrides,
  }
}
