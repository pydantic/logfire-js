const VALUE_SIG_FIGS = 3
const ABS_SIG_FIGS = 3
const PERC_DECIMALS = 1
const MULTIPLIER_ONE_DECIMAL_THRESHOLD = 100
const BASE_THRESHOLD = 1e-2
const MULTIPLIER_DROP_FACTOR = 10

function formatGroupedFixed(value: number, decimals: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: decimals, useGrouping: true })
}

export function defaultRenderNumber(value: number): string {
  if (Number.isInteger(value)) {
    return value.toLocaleString('en-US', { useGrouping: true })
  }
  const absVal = Math.abs(value)
  let decimals: number
  if (absVal === 0) {
    decimals = VALUE_SIG_FIGS
  } else if (absVal >= 1) {
    const digits = Math.floor(Math.log10(absVal)) + 1
    decimals = Math.max(1, VALUE_SIG_FIGS - digits)
  } else {
    const exponent = Math.floor(Math.log10(absVal))
    decimals = -exponent + VALUE_SIG_FIGS - 1
  }
  return formatGroupedFixed(value, decimals)
}

export function defaultRenderPercentage(value: number): string {
  const decimals = VALUE_SIG_FIGS - 2
  return `${(value * 100).toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: decimals })}%`
}

function renderSignedSigFigs(val: number, sigFigs: number): string {
  const absStr = Math.abs(val).toPrecision(sigFigs)
  // Match Python's behavior: if no decimal/exponent, add '.0'
  let s = absStr
  // JavaScript's toPrecision may return scientific notation for very small/large numbers
  if (!s.includes('e') && !s.includes('.')) {
    s += '.0'
  }
  // Apply grouping to integer part
  if (!s.includes('e')) {
    const parts = s.split('.')
    parts[0] = Number(parts[0]).toLocaleString('en-US', { useGrouping: true })
    s = parts.join('.')
  }
  return `${val >= 0 ? '+' : '-'}${s}`
}

function renderRelative(newVal: number, base: number, smallBaseThreshold: number): null | string {
  if (base === 0) return null
  const delta = newVal - base
  if (Math.abs(base) < smallBaseThreshold && Math.abs(delta) > MULTIPLIER_DROP_FACTOR * Math.abs(base)) return null
  const relChange = (delta / base) * 100
  const sign = relChange >= 0 ? '+' : ''
  const percStr = `${sign}${relChange.toFixed(PERC_DECIMALS)}%`
  if (percStr === '+0.0%' || percStr === '-0.0%') return null
  if (Math.abs(delta) / Math.abs(base) <= 1) {
    return percStr
  }
  const multiplier = newVal / base
  if (Math.abs(multiplier) < MULTIPLIER_ONE_DECIMAL_THRESHOLD) {
    return `${formatGroupedFixed(multiplier, 1)}x`
  }
  return `${formatGroupedFixed(multiplier, 0)}x`
}

function renderDuration(seconds: number, forceSigned: boolean): string {
  if (seconds === 0) return '0s'
  let precision = 1
  const absSeconds = Math.abs(seconds)
  let value: number
  let unit: string
  if (absSeconds < 1e-3) {
    value = seconds * 1_000_000
    unit = 'µs'
    if (Math.abs(value) >= 1) precision = 0
  } else if (absSeconds < 1) {
    value = seconds * 1_000
    unit = 'ms'
  } else {
    value = seconds
    unit = 's'
  }
  const sign = forceSigned && value >= 0 ? '+' : ''
  return `${sign}${formatGroupedFixed(value, precision)}${unit}`
}

export function defaultRenderNumberDiff(oldVal: number, newVal: number): null | string {
  if (oldVal === newVal) return null
  if (Number.isInteger(oldVal) && Number.isInteger(newVal)) {
    const diff = newVal - oldVal
    return `${diff >= 0 ? '+' : ''}${diff.toString()}`
  }
  const delta = newVal - oldVal
  const absDiffStr = renderSignedSigFigs(delta, ABS_SIG_FIGS)
  const relDiffStr = renderRelative(newVal, oldVal, BASE_THRESHOLD)
  return relDiffStr === null ? absDiffStr : `${absDiffStr} / ${relDiffStr}`
}

export function defaultRenderDuration(seconds: number): string {
  return renderDuration(seconds, false)
}

export function defaultRenderDurationDiff(oldVal: number, newVal: number): null | string {
  if (oldVal === newVal) return null
  const absDiffStr = renderDuration(newVal - oldVal, true)
  const relDiffStr = renderRelative(newVal, oldVal, BASE_THRESHOLD)
  return relDiffStr === null ? absDiffStr : `${absDiffStr} / ${relDiffStr}`
}
