import type { FlagProviderState, ResolvedVariable } from 'logfire/vars'

type FlagErrorCode = 'flag_not_found' | 'general' | 'provider_not_ready' | 'targeting_key_missing' | 'type_mismatch'

export type FlagDetails<T> = {
  flagKey: string
  value: T
} & (
  | { reason: 'error'; errorCode: FlagErrorCode; variant?: never; valueVersion?: never }
  | {
      reason: 'context_override' | 'default' | 'split' | 'stale' | 'static' | 'targeting_match'
      errorCode?: never
      variant?: string
      valueVersion?: number
    }
)

export function toFlagDetails<T>(result: ResolvedVariable<T>, state: FlagProviderState): FlagDetails<T> {
  const details = { flagKey: result.name, value: structuredClone(result.value) }
  if (result.reason === 'context_override') {
    return { ...details, reason: 'context_override' }
  }
  const errorCode = errorForResolution(result, state)
  if (errorCode !== undefined) {
    return { ...details, reason: 'error', errorCode }
  }
  return {
    ...details,
    reason: state === 'stale' ? 'stale' : result.reason === 'resolved' ? (result.ruleReason ?? 'static') : 'default',
    ...(result.label === undefined ? {} : { variant: result.label }),
    ...(result.version === undefined ? {} : { valueVersion: result.version }),
  }
}

function errorForResolution(result: ResolvedVariable<unknown>, state: FlagProviderState): FlagErrorCode | undefined {
  if (state === 'not_ready') {
    return 'provider_not_ready'
  }
  if (state === 'error') {
    return 'general'
  }
  if (result.targetingKeyMissing) {
    return 'targeting_key_missing'
  }
  if (result.reason === 'other_error') {
    return 'general'
  }
  if (result.reason === 'validation_error') {
    return 'type_mismatch'
  }
  if (result.reason === 'unrecognized_variable') {
    return 'flag_not_found'
  }
  return undefined
}
