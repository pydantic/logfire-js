import { describe, expect, it } from 'vitest'

import { AgentSandboxError } from './errors'
import { agentSandboxesUrl } from './url'

describe('agentSandboxesUrl', () => {
  it('keeps an https base URL', () => {
    expect(agentSandboxesUrl('https://logfire-eu.pydantic.dev')).toBe('https://logfire-eu.pydantic.dev')
  })

  it('keeps http and the port', () => {
    expect(agentSandboxesUrl('http://localhost:8000')).toBe('http://localhost:8000')
  })

  it('strips trailing slashes', () => {
    expect(agentSandboxesUrl('https://logfire.example.com//')).toBe('https://logfire.example.com')
  })

  /** The session RPC path is fixed, so neither configuration source may supply a path, query, or fragment. */
  it.each([
    'https://logfire.example.com/monty-ws/',
    'https://logfire.example.com/other/path//',
    'https://logfire.example.com/other/..',
    'https://logfire.example.com/.',
    'https://logfire.example.com/other/../',
    'https://logfire.example.com\\monty-ws\\',
    'https://logfire.example.com?region=us',
    'https://logfire.example.com/?region=us',
    'https://logfire.example.com#sandbox',
    'https://logfire.example.com/#sandbox',
    'https://logfire.example.com?',
    'https://logfire.example.com#',
    'not a URL',
    '',
    'ftp://logfire.example.com',
    'https:logfire.example.com',
    'https://logfire.example.com:invalid',
  ])('rejects %j with configuration advice', (url) => {
    expect(() => agentSandboxesUrl(url)).toThrow(
      new AgentSandboxError(
        'Agent Sandboxes URL must use http://<host> or https://<host> with no path, query or fragment. ' +
          'Remove the old /monty-ws/ path from `url` or LOGFIRE_BASE_URL.'
      )
    )
  })
})
