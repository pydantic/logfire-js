/**
 * Default primaryArgKey map for built-in evaluators. Used by `Dataset.fromText`
 * etc. to round-trip single-positional short forms (`{Equals: 1}`) back into
 * options-object constructor calls (`new Equals({ value: 1 })`).
 */
export const BUILTIN_PRIMARY_ARG_KEYS: Record<string, string> = {
  Contains: 'value',
  Equals: 'value',
  HasMatchingSpan: 'query',
  IsInstance: 'type_name',
  LLMJudge: 'rubric',
  MaxDuration: 'seconds',
}
