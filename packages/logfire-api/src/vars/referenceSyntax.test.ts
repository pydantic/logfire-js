import { describe, expect, it } from 'vitest'

import { renderOnce } from './referenceSyntax'

describe('variable reference syntax', () => {
  it('renders @{} references while preserving runtime placeholders', () => {
    expect(renderOnce('Hello @{name}@, keep {{runtime}}', { name: 'Ada' })).toBe('Hello Ada, keep {{runtime}}')
  })

  it('turns escaped references into literal references', () => {
    expect(renderOnce('\\@{name}@ and @{name}@', { name: 'Ada' })).toBe('@{name}@ and Ada')
  })

  it('supports block helpers', () => {
    expect(renderOnce('@{#if enabled}@on@{else}@off@{/if}@', { enabled: true })).toBe('on')
    expect(renderOnce('@{#if enabled}@on@{else}@off@{/if}@', { enabled: false })).toBe('off')
  })

  it('does not HTML-escape safe context string leaves', () => {
    expect(renderOnce('@{name}@', { name: '<Ada>' })).toBe('<Ada>')
  })
})
