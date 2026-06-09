import { describe, expect, it } from 'vitest'

import { findReferencesAndErrorsInString, hasCompositionReferences } from './reference-syntax'

describe('variable reference syntax public parser entrypoint', () => {
  it('extracts composition references without collecting runtime template paths', () => {
    expect(findReferencesAndErrorsInString('{{runtime}} @{b}@ @{a.field}@ @{lookup obj key}@ @{b}@')).toEqual({
      errors: [],
      references: ['a', 'b', 'key', 'obj'],
    })
  })

  it('handles escaped references through the public parser entrypoint', () => {
    expect(findReferencesAndErrorsInString('\\@{escaped}@ @{real}@')).toEqual({ errors: [], references: ['real'] })
    expect(hasCompositionReferences('\\@{escaped}@')).toBe(false)
  })
})
