import type { ResolvedVariable } from 'logfire/vars'

export interface FlagDetails<T> {
  flagKey: string
  value: T
  reason: 'context_override' | 'default' | 'error' | 'split' | 'stale' | 'static' | 'targeting_match'
  variant?: string
  errorCode?: 'flag_not_found' | 'general' | 'provider_not_ready' | 'targeting_key_missing' | 'type_mismatch'
  valueVersion?: number
}

export function toFlagDetails<T>(result: ResolvedVariable<T>, state: 'ready' | 'stale' | 'not_ready' | 'error'): FlagDetails<T> {
  const details: FlagDetails<T> = { flagKey: result.name, reason: 'default', value: structuredClone(result.value) }
  if (result.reason === 'context_override') {
    return { ...details, reason: 'context_override' }
  }
  const errorCode = errorForResolution(result.reason, state)
  if (errorCode !== undefined) {
    return { ...details, reason: 'error', errorCode }
  }
  if (state === 'stale') {
    details.reason = 'stale'
  } else if (result.reason === 'resolved') {
    details.reason = result.ruleReason ?? 'static'
  }
  if (result.label !== undefined) {
    details.variant = result.label
  }
  if (result.version !== undefined) {
    details.valueVersion = result.version
  }
  return details
}

function errorForResolution(reason: ResolvedVariable<unknown>['reason'], state: string): FlagDetails<unknown>['errorCode'] {
  if (state === 'not_ready') {
    return 'provider_not_ready'
  }
  if (state === 'error' || reason === 'other_error') {
    return 'general'
  }
  if (reason === 'validation_error') {
    return 'type_mismatch'
  }
  if (reason === 'unrecognized_variable') {
    return 'flag_not_found'
  }
  if (reason === 'missing_targeting_key') {
    return 'targeting_key_missing'
  }
  return undefined
}
