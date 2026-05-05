---
title: Sampling
description: Control Logfire TypeScript SDK trace volume with head and tail sampling.
---

# Sampling

Sampling controls which traces are exported. The TypeScript SDK supports head sampling and tail sampling.

## Head Sampling

Head sampling makes a probabilistic decision when a trace starts:

```ts
import * as logfire from '@pydantic/logfire-node'

logfire.configure({
  sampling: { head: 0.1 },
  serviceName: 'checkout-api',
})
```

In Node.js, `LOGFIRE_TRACE_SAMPLE_RATE=0.1` configures head sampling from the environment.

## Tail Sampling

Tail sampling can keep traces based on span level or duration:

```ts
logfire.configure({
  sampling: logfire.levelOrDuration({
    durationThreshold: 2.0,
    levelThreshold: 'warning',
  }),
  serviceName: 'checkout-api',
})
```

You can also provide a callback:

```ts
logfire.configure({
  sampling: {
    tail: (spanInfo) => {
      if (spanInfo.level.gte('error')) return 1.0
      if (spanInfo.duration > 1.5) return 1.0
      return 0.0
    },
  },
  serviceName: 'worker',
})
```

Tail sampling buffers spans until a decision can be made. Be conservative in browsers and long-lived processes because buffering can increase memory usage.

See `examples/node/sampling.ts` for a runnable example.
