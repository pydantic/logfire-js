import { describe, expect, it } from 'vitest'

import { expandReferences, findReferences, hasFatalCompositionError } from './composition'
import type { ResolvedReference } from './composition'

const resolved = (value: unknown, extra: Partial<ResolvedReference> = {}): ResolvedReference => ({
  reason: 'resolved',
  value: JSON.stringify(value),
  ...extra,
})

const missing = (name: string): ResolvedReference => ({ name, reason: 'unrecognized_variable', value: undefined })

const resolver =
  (values: Record<string, ResolvedReference>) =>
  (name: string): ResolvedReference =>
    values[name] ?? missing(name)

describe('variable composition', () => {
  it('finds simple, dotted, and block references in encounter order', () => {
    expect(findReferences('@{greeting}@ @{brand.tagline}@ @{#if beta}@yes@{/if}@ @{greeting}@')).toEqual(['greeting', 'brand', 'beta'])
    expect(findReferences('\\@{escaped}@ @{#if this}@yes@{/if}@ @{else}@')).toEqual([])
  })

  it('expands simple and duplicate references once in metadata', async () => {
    const result = await expandReferences(
      JSON.stringify('@{greeting}@, @{greeting}@ World'),
      resolver({ greeting: resolved('Hello', { label: 'production', version: 1 }) })
    )

    expect(JSON.parse(result.serializedValue)).toBe('Hello, Hello World')
    expect(result.composedFrom).toEqual([
      {
        label: 'production',
        name: 'greeting',
        reason: 'resolved',
        value: '"Hello"',
        version: 1,
      },
    ])
  })

  it('expands nested references and preserves nested metadata', async () => {
    const result = await expandReferences(
      JSON.stringify('@{outer}@'),
      resolver({
        inner: resolved('inside'),
        outer: resolved('@{inner}@'),
      })
    )

    expect(JSON.parse(result.serializedValue)).toBe('inside')
    expect(result.composedFrom[0]?.composedFrom?.[0]).toMatchObject({ name: 'inner', value: '"inside"' })
  })

  it('expands nested references inside structured referenced values', async () => {
    const result = await expandReferences(
      JSON.stringify('@{config.prompt}@ using @{config.model}@'),
      resolver({
        config: resolved({ model: 'gpt-4', prompt: 'Hello @{name}@' }),
        name: resolved('Alice'),
      })
    )

    expect(JSON.parse(result.serializedValue)).toBe('Hello Alice using gpt-4')
    expect(result.composedFrom).toHaveLength(1)
    expect(result.composedFrom[0]).toMatchObject({
      composedFrom: [{ name: 'name', value: '"Alice"' }],
      name: 'config',
      value: '{"model":"gpt-4","prompt":"Hello Alice"}',
    })
  })

  it('walks structured values and supports dotted references', async () => {
    const result = await expandReferences(
      JSON.stringify({ items: ['@{brand.tagline}@', 3], title: '@{brand.name}@' }),
      resolver({ brand: resolved({ name: 'Logfire', tagline: 'Observe everything' }) })
    )

    expect(JSON.parse(result.serializedValue)).toEqual({
      items: ['Observe everything', 3],
      title: 'Logfire',
    })
  })

  it('walks lists and leaves non-string values unchanged', async () => {
    const result = await expandReferences(
      JSON.stringify(['@{greeting}@ @{name}@', 42, { nested: '@{name}@' }]),
      resolver({ greeting: resolved('Hello'), name: resolved('Alice') })
    )

    expect(JSON.parse(result.serializedValue)).toEqual(['Hello Alice', 42, { nested: 'Alice' }])
    expect(result.composedFrom.map((reference) => reference.name)).toEqual(['greeting', 'name'])
  })

  it('supports block helpers without treating helper keywords as variables', async () => {
    const result = await expandReferences(JSON.stringify('@{#if beta}@beta@{else}@stable@{/if}@'), resolver({ beta: resolved(true) }))

    expect(JSON.parse(result.serializedValue)).toBe('beta')
    expect(result.composedFrom).toHaveLength(1)
  })

  it('supports unless, each, and with block helper contexts', async () => {
    const values = resolver({
      beta: resolved(false),
      brand: resolved({ tagline: 'Observe everything' }),
      items: resolved(['a', 'b']),
    })

    await expect(expandReferences(JSON.stringify('@{#unless beta}@stable@{/unless}@'), values)).resolves.toMatchObject({
      serializedValue: JSON.stringify('stable'),
    })
    await expect(expandReferences(JSON.stringify('@{#each items}@<@{this}@>@{/each}@'), values)).resolves.toMatchObject({
      serializedValue: JSON.stringify('<a><b>'),
    })
    await expect(expandReferences(JSON.stringify('@{#with brand}@@{this.tagline}@@{/with}@'), values)).resolves.toMatchObject({
      serializedValue: JSON.stringify('Observe everything'),
    })
  })

  it('preserves unresolved nested same-helper blocks inside resolved blocks', async () => {
    const result = await expandReferences(
      JSON.stringify('@{#each outer}@start @{#each inner}@data@{/each}@ end@{/each}@'),
      resolver({ outer: resolved(['item']) })
    )

    expect(JSON.parse(result.serializedValue)).toBe('start @{#each inner}@data@{/each}@ end')
    expect(result.composedFrom).toEqual([
      { name: 'outer', reason: 'resolved', value: '["item"]' },
      { name: 'inner', reason: 'unrecognized_variable' },
    ])
  })

  it('preserves runtime placeholders and escaped references', async () => {
    const result = await expandReferences(JSON.stringify('\\@{name}@ @{name}@ {{runtime}}'), resolver({ name: resolved('Ada') }))

    expect(JSON.parse(result.serializedValue)).toBe('@{name}@ Ada {{runtime}}')
    expect(result.composedFrom).toHaveLength(1)
  })

  it('preserves referenced HTML entities and escaped reference syntax', async () => {
    await expect(
      expandReferences(JSON.stringify('@{ref}@'), resolver({ ref: resolved('literal &#123; and &#125;') }))
    ).resolves.toMatchObject({
      serializedValue: JSON.stringify('literal &#123; and &#125;'),
    })
    await expect(expandReferences(JSON.stringify('@{ref}@'), resolver({ ref: resolved('\\@{not_a_ref}@') }))).resolves.toMatchObject({
      serializedValue: JSON.stringify('\\@{not_a_ref}@'),
    })
  })

  it('preserves JSON encoding for rendered reference values', async () => {
    const value = 'line 1\n"quoted" \\ slash café'
    const result = await expandReferences(JSON.stringify('Value: @{text}@'), resolver({ text: resolved(value) }))

    expect(JSON.parse(result.serializedValue)).toBe(`Value: ${value}`)
  })

  it('keeps unresolved references literal and records metadata', async () => {
    const result = await expandReferences(JSON.stringify('@{missing}@ @{present}@'), resolver({ present: resolved('ok') }))

    expect(JSON.parse(result.serializedValue)).toBe('@{missing}@ ok')
    expect(result.composedFrom).toEqual([
      { name: 'missing', reason: 'unrecognized_variable' },
      { name: 'present', reason: 'resolved', value: '"ok"' },
    ])
  })

  it('keeps unresolved dotted references literal', async () => {
    await expect(expandReferences(JSON.stringify('Hello @{nonexistent.field}@'), resolver({}))).resolves.toMatchObject({
      composedFrom: [{ name: 'nonexistent', reason: 'unrecognized_variable' }],
      serializedValue: JSON.stringify('Hello @{nonexistent.field}@'),
    })
    await expect(
      expandReferences(JSON.stringify('Hi @{known}@ @{missing.field}@'), resolver({ known: resolved('there') }))
    ).resolves.toMatchObject({
      composedFrom: [
        { name: 'known', reason: 'resolved', value: '"there"' },
        { name: 'missing', reason: 'unrecognized_variable' },
      ],
      serializedValue: JSON.stringify('Hi there @{missing.field}@'),
    })
  })

  it('records invalid referenced JSON without replacing the reference', async () => {
    const result = await expandReferences(JSON.stringify('@{bad}@'), resolver({ bad: { reason: 'resolved', value: 'not-json' } }))

    expect(JSON.parse(result.serializedValue)).toBe('@{bad}@')
    expect(result.composedFrom[0]?.error).toContain('non-JSON')
  })

  it('records cycles as fatal composition errors', async () => {
    const result = await expandReferences(
      JSON.stringify('@{b}@'),
      resolver({
        a: resolved('@{b}@'),
        b: resolved('@{a}@'),
      }),
      { rootName: 'a' }
    )

    expect(JSON.parse(result.serializedValue)).toBe('@{a}@')
    expect(hasFatalCompositionError(result.composedFrom)).toBe(true)
    expect(result.composedFrom[0]?.composedFrom?.[0]?.error).toBe('VariableCompositionCycleError: Circular variable reference: a -> b -> a')
  })

  it('records depth overflows as fatal composition errors', async () => {
    const values: Record<string, ResolvedReference> = {}
    for (let index = 0; index < 22; index += 1) {
      values[`v${String(index)}`] = resolved(`@{v${String(index + 1)}}@`)
    }
    values['v22'] = resolved('done')

    const result = await expandReferences(JSON.stringify('@{v0}@'), resolver(values), { rootName: 'root' })

    expect(hasFatalCompositionError(result.composedFrom)).toBe(true)
  })
})
