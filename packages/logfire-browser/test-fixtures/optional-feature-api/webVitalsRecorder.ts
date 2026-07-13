type Callback = (metric: unknown) => void

let fcpCallback: Callback | undefined

export function hasWebVitalsRegistration(): boolean {
  return fcpCallback !== undefined
}

export function emitWebVital(): boolean {
  if (fcpCallback === undefined) {
    return false
  }
  fcpCallback({
    attribution: { firstByteToFCP: 5, loadState: 'complete', timeToFirstByte: 10 },
    delta: 15,
    entries: [],
    id: 'fixture-fcp',
    name: 'FCP',
    navigationType: 'navigate',
    rating: 'good',
    value: 15,
  })
  return true
}

export const onCLS = (_callback: Callback): void => undefined
export const onFCP = (callback: Callback): void => {
  fcpCallback = callback
}
export const onINP = (_callback: Callback): void => undefined
export const onLCP = (_callback: Callback): void => undefined
export const onTTFB = (_callback: Callback): void => undefined
