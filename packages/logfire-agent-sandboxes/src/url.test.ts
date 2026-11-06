import { describe, expect, it } from 'vitest'

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
})
