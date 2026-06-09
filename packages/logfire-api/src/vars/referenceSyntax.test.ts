import { describe, expect, it } from 'vitest'

import { findReferencesAndErrorsInString, hasCompositionReferences, renderOnce } from './referenceSyntax'

describe('variable reference syntax', () => {
  it('renders @{} references while preserving runtime placeholders', () => {
    expect(renderOnce('Hello @{name}@, keep {{runtime}}', { name: 'Ada' })).toBe('Hello Ada, keep {{runtime}}')
  })

  it('preserves triple and quad runtime delimiters', () => {
    expect(renderOnce('@{name}@ {{{html}}} {{{{raw}}}}{{runtime}}{{{{/raw}}}}', { name: 'Ada' })).toBe(
      'Ada {{{html}}} {{{{raw}}}}{{runtime}}{{{{/raw}}}}'
    )
  })

  it('renders composition references inside runtime Handlebars blocks without rendering the runtime block', () => {
    expect(renderOnce('{{#if @{enabled}@}}Hello {{name}}{{/if}}', { enabled: true })).toBe('{{#if true}}Hello {{name}}{{/if}}')
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

  it('supports helper arguments and parent references while rendering composition syntax', () => {
    expect(renderOnce('@{lookup obj key}@', { key: 'greeting', obj: { greeting: 'Hi' } })).toBe('Hi')
    expect(renderOnce('@{#each tags}@@{this}@@{../sep}@@{/each}@', { sep: '-', tags: ['a', 'b'] })).toBe('a-b-')
  })

  it('extracts sorted unique composition references while ignoring runtime template paths', () => {
    expect(findReferencesAndErrorsInString('{{runtime}} @{b}@ @{a.field}@ @{lookup obj key}@ @{b}@')).toEqual({
      errors: [],
      references: ['a', 'b', 'key', 'obj'],
    })
  })

  it('extracts references from composition tags inside runtime blocks', () => {
    expect(findReferencesAndErrorsInString('{{#if @{enabled}@}}{{runtime}}{{/if}}')).toEqual({
      errors: [],
      references: ['enabled'],
    })
  })

  it('treats context-shifting block bodies as local scope for dependency extraction', () => {
    expect(findReferencesAndErrorsInString('@{#if cond}@@{#each items}@@{lookup obj key}@@{else}@@{fallback}@@{/each}@@{/if}@')).toEqual({
      errors: [],
      references: ['cond', 'fallback', 'items'],
    })
  })

  it('ignores escaped composition starts during dependency extraction', () => {
    expect(findReferencesAndErrorsInString('\\@{escaped}@ @{real}@')).toEqual({ errors: [], references: ['real'] })
    expect(hasCompositionReferences('\\@{escaped}@')).toBe(false)
  })

  it('returns parser diagnostics for malformed composition templates', () => {
    const result = findReferencesAndErrorsInString('@{#if flag}@x')

    expect(result.references).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.type).toBe('parse_error')
  })
})
