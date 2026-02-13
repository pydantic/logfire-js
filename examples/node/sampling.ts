import * as logfire from '@pydantic/logfire-node'

// --- Configuration ---
// This example demonstrates three sampling modes. Uncomment the one you want to try.

// MODE 1: Head sampling only — keep 50% of traces (probabilistic, decided at trace creation)
// logfire.configure({
//   serviceName: 'sampling-demo',
//   console: true,
//   sendToLogfire: false,
//   sampling: { head: 0.5 },
// })

// MODE 2: Tail sampling only — keep traces that have warning+ spans or last > 2 seconds
// logfire.configure({
//   serviceName: 'sampling-demo',
//   console: true,
//   sendToLogfire: false,
//   sampling: logfire.levelOrDuration({ levelThreshold: 'warning', durationThreshold: 2.0 }),
// })

// MODE 3: Tail sampling with a custom callback
logfire.configure({
  serviceName: 'sampling-demo',
  sampling: {
    tail: (spanInfo) => {
      // Keep any trace that contains an error-level span
      if (spanInfo.level.gte('error')) return 1.0
      // Keep traces running longer than 1.5 seconds
      if (spanInfo.duration > 1.5) return 1.0
      // Drop everything else
      return 0.0
    },
  },
})

console.log('\n--- Trace 1: quick info-level trace (should be DROPPED) ---')
logfire.span('fast operation', {
  callback: () => {
    logfire.info('all good here')
  },
})

console.log('\n--- Trace 2: trace with an error (should be KEPT) ---')
logfire.span('operation with error', {
  callback: () => {
    logfire.info('starting work')
    logfire.error('something broke', { detail: 'disk full' })
    logfire.info('attempted recovery')
  },
})

console.log('\n--- Trace 3: slow trace (should be KEPT after delay) ---')
await logfire.span('slow operation', {
  callback: async () => {
    logfire.info('step 1')
    await new Promise((resolve) => setTimeout(resolve, 2000))
    logfire.info('step 2 - this triggers the duration threshold')
  },
})

console.log('\n--- Done ---')
console.log('Check the console output above. You should see spans from traces 2 and 3,')
console.log('but NOT from trace 1 (it was dropped by tail sampling).')
