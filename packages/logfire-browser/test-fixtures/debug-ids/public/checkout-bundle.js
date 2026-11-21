// Stands in for a classic-script bundle after `logfire sourcemap inject`: the snippet registers
// this file's debug ID under the stack it captures, because document.currentScript is not usable
// in module scripts.
!(function () {
  try {
    var g = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : self
    var stack = new g.Error().stack
    if (stack) {
      g._logfireDebugIds = g._logfireDebugIds || {}
      g._logfireDebugIds[stack] = '5b1c2a7e-8f4d-4e3b-9a61-0c2d3e4f5a6b'
      g._logfireRelease = '2026.11.02-9f3c2ab'
    }
  } catch (e) {}
})()

window.chargeCard = function chargeCard() {
  throw new Error('card declined')
}
