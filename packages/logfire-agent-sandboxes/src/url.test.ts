import { describe, expect, it } from 'vitest'

import { agentSandboxesUrl } from './url'

describe('agentSandboxesUrl', () => {
  it('maps https to wss', () => {
    expect(agentSandboxesUrl('https://logfire-eu.pydantic.dev')).toBe('wss://logfire-eu.pydantic.dev/monty-ws/')
  })

  it('maps http to ws and keeps the port', () => {
    expect(agentSandboxesUrl('http://localhost:8000')).toBe('ws://localhost:8000/monty-ws/')
  })

  it('appends to a path prefix without doubling slashes', () => {
    expect(agentSandboxesUrl('https://logfire.example.com/prefix/')).toBe('wss://logfire.example.com/prefix/monty-ws/')
  })
})
