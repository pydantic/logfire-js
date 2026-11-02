// A loaded bundle with a debug ID that never appears in the failing stack.
!(function () {
  try {
    var g = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : self
    var stack = new g.Error().stack
    if (stack) {
      g._logfireDebugIds = g._logfireDebugIds || {}
      g._logfireDebugIds[stack] = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a'
    }
  } catch (e) {}
})()
